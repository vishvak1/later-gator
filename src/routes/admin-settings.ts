import { z } from "zod";
import { AdminStateStore } from "../adapters/admin-state-store";
import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { createOrganizationProvider } from "../adapters/organization-provider";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { OperationalStateStore } from "../adapters/operational-state-store";
import { ProviderConfigStore } from "../adapters/provider-config-store";
import { RaindropClient } from "../adapters/raindrop-client";
import { dispatchUnsorted } from "../application/dispatch";
import { resumePipeline } from "../application/pipeline-control";
import { resyncRegistryIfDue } from "../application/registry-resync";
import { generateMcpSecret } from "../application/mcp-secret";
import { parseRuntimeConfig } from "../config";
import type { ProviderChoice } from "../domain/schemas";
import { readBoundedUrlEncodedForm, RequestBodyError } from "./request-body";
import { getInstallationSecret, requireSetupMutation } from "./setup-auth";

const MAX_REQUEST_BYTES = 24_000;
const DispatchLimitSchema = z.coerce.number().int().min(1).max(50);

export async function savePrompt(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  const personal = z.string().max(4_000).safeParse(form.get("personalInstructions") ?? "");
  const advancedEnabled = form.get("advanced") === "enabled";
  const override = z.string().max(20_000).safeParse(form.get("fullPromptOverride") ?? "");
  if (!personal.success || !override.success) return textError("Prompt settings are too long.");
  if (advancedEnabled && form.get("warning") !== "OVERRIDE") {
    return textError("Type OVERRIDE to enable the advanced full-prompt override.");
  }
  const config = parseRuntimeConfig(env);
  const store = new ProviderConfigStore(env.STATE, initialChoice(config));
  await store.updatePrompt({
    personalInstructions: personal.data,
    fullPromptOverride:
      advancedEnabled && override.data.trim().length > 0 ? override.data : null,
  });
  await activity(env, "prompt", "changed");
  return redirect();
}

export async function restorePrompt(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  if (form.get("confirmation") !== "RESTORE") return textError("Type RESTORE to confirm.");
  const config = parseRuntimeConfig(env);
  await new ProviderConfigStore(env.STATE, initialChoice(config)).restoreDefaultPrompt();
  await activity(env, "prompt", "restored");
  return redirect();
}

export async function saveAutomation(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  const limit = DispatchLimitSchema.safeParse(form.get("dispatchLimit"));
  if (!limit.success) return textError("Discovery batch limit must be between 1 and 50.");
  const config = parseRuntimeConfig(env);
  const store = new AdminStateStore(env.STATE, config.DISPATCH_LIMIT);
  const current = await store.getAutomation();
  await store.putAutomation({
    ...current,
    dispatchLimit: limit.data,
    revision: current.revision + 1,
  });
  return redirect();
}

export async function pauseAutomation(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  if (form.get("confirmation") !== "PAUSE") return textError("Type PAUSE to confirm.");
  const store = new OperationalStateStore(env.STATE);
  const pipeline = await store.getPipeline();
  if (!pipeline.paused) {
    await store.putPipeline({
      ...pipeline,
      paused: true,
      pauseReason: "paused_by_owner",
      pausedAt: new Date().toISOString(),
      revision: pipeline.revision + 1,
    });
  }
  await activity(env, "pipeline", "paused");
  return redirect();
}

export async function resumeAutomation(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  const dependencies = await runtimeDependencies(env);
  if (dependencies instanceof Response) return dependencies;
  const result = await resumePipeline(
    env.STATE,
    dependencies.raindrop,
    dependencies.provider,
    form.get("confirmation") === "RESUME",
  );
  if (result.status === "refused") return textError(`Resume refused: ${result.reason}.`, 409);
  await activity(env, "pipeline", result.status);
  return redirect();
}

export async function startBackfill(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  if (form.get("confirmation") !== "START") return textError("Type START to confirm.");
  const onboarding = await new OnboardingStateStore(env.STATE).get();
  if (onboarding.status !== "complete") return textError("Finish onboarding first.", 409);
  const dependencies = await runtimeDependencies(env);
  if (dependencies instanceof Response) return dependencies;
  try {
    await dependencies.provider.testConnection();
  } catch {
    return textError("The active provider did not pass validation.", 409);
  }
  const store = new OperationalStateStore(env.STATE);
  const pipeline = await store.getPipeline();
  const next = {
    ...pipeline,
    mode: "backfill" as const,
    backfillSessionId: pipeline.backfillSessionId ?? crypto.randomUUID(),
    revision: pipeline.revision + 1,
  };
  await store.putPipeline(next);
  await dispatchBackfill(env, dependencies.raindrop);
  await activity(env, "backfill", "started");
  return redirect();
}

export async function continueBackfill(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  const dependencies = await runtimeDependencies(env);
  if (dependencies instanceof Response) return dependencies;
  await dispatchBackfill(env, dependencies.raindrop);
  return redirect();
}

export async function stopBackfill(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  if (form.get("confirmation") !== "STOP") return textError("Type STOP to confirm.");
  const store = new OperationalStateStore(env.STATE);
  const pipeline = await store.getPipeline();
  await store.putPipeline({
    ...pipeline,
    mode: "scheduled",
    backfillSessionId: null,
    revision: pipeline.revision + 1,
  });
  await activity(env, "backfill", "stopped");
  return redirect();
}

export async function rebuildRegistry(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  if (form.get("confirmation") !== "REBUILD") return textError("Type REBUILD to confirm.");
  const dependencies = await runtimeDependencies(env);
  if (dependencies instanceof Response) return dependencies;
  const config = parseRuntimeConfig(env);
  await resyncRegistryIfDue(
    env.STATE,
    dependencies.raindrop,
    new Date(),
    new AdminStateStore(env.STATE, config.DISPATCH_LIMIT),
    true,
  );
  return redirect();
}

export async function rotateMcpSecret(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const auth = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (auth instanceof Response) return auth;
  if (form.get("confirmation") !== "ROTATE") return textError("Type ROTATE to confirm.");
  const secret = generateMcpSecret();
  await new EncryptedCredentialStore(
    env.STATE,
    getInstallationSecret(env),
  ).set("mcpPath", secret);
  await activity(env, "mcp_secret", "rotated");
  return redirect();
}

async function dispatchBackfill(env: Env, raindrop: RaindropClient): Promise<void> {
  const config = parseRuntimeConfig(env);
  const admin = new AdminStateStore(env.STATE, config.DISPATCH_LIMIT);
  const automation = await admin.getAutomation();
  const result = await dispatchUnsorted(
    env.STATE,
    env.ORGANIZE_QUEUE,
    raindrop,
    automation.dispatchLimit,
    new Date(),
    "backfill",
  );
  if (result.outcome === "empty") {
    const operational = new OperationalStateStore(env.STATE);
    const [dispatch, pipeline] = await Promise.all([
      operational.getDispatch(),
      operational.getPipeline(),
    ]);
    if (Object.keys(dispatch.leases).length === 0) {
      await operational.putPipeline({
        ...pipeline,
        mode: "scheduled",
        backfillSessionId: null,
        revision: pipeline.revision + 1,
      });
      await admin.recordActivity({
        at: new Date().toISOString(),
        event: "backfill",
        outcome: "completed",
      });
    }
  }
}

async function runtimeDependencies(env: Env) {
  const config = parseRuntimeConfig(env);
  const credentials = new EncryptedCredentialStore(env.STATE, getInstallationSecret(env));
  const token = await credentials.get("raindrop");
  if (token === null) return textError("Raindrop credential is missing.", 409);
  const providerState = await new ProviderConfigStore(
    env.STATE,
    initialChoice(config),
  ).get();
  const providerCredential =
    providerState.active.provider === "workers-ai"
      ? null
      : await credentials.get(providerState.active.provider);
  try {
    return {
      raindrop: new RaindropClient(token),
      provider: createOrganizationProvider(providerState.active, {
        ai: env.AI,
        credential: providerCredential,
      }),
    };
  } catch {
    return textError("Active provider configuration is incomplete.", 409);
  }
}

async function activity(env: Env, event: string, outcome: string): Promise<void> {
  const config = parseRuntimeConfig(env);
  await new AdminStateStore(env.STATE, config.DISPATCH_LIMIT).recordActivity({
    at: new Date().toISOString(),
    event,
    outcome,
  });
}

async function readForm(request: Request): Promise<URLSearchParams | Response> {
  try {
    return await readBoundedUrlEncodedForm(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return textError(error.message, error.status);
    throw error;
  }
}

function initialChoice(config: ReturnType<typeof parseRuntimeConfig>): ProviderChoice {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    promptRevision: 1,
  };
}

function redirect(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/setup", "cache-control": "no-store" },
  });
}

function textError(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
