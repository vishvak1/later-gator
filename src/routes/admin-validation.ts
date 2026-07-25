import { z } from "zod";
import { validateInstallation, InstallationValidationError } from "../application/validate-installation";
import { EmailConfigStore } from "../adapters/email-config-store";
import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { KvStateStore } from "../adapters/kv-state-store";
import {
  createOrganizationProvider,
  ProviderConnectionError,
} from "../adapters/organization-provider";
import {
  ProviderActivationError,
  ProviderConfigStore,
} from "../adapters/provider-config-store";
import { parseRuntimeConfig } from "../config";
import {
  InstallationStateSchema,
  ProviderNameSchema,
  type EmailConfigState,
  type ProviderChoice,
} from "../domain/schemas";
import { readBoundedUrlEncodedForm, RequestBodyError } from "./request-body";
import {
  getInstallationSecret,
  readSetupSession,
  requireSetupMutation,
} from "./setup-auth";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { OperationalStateStore } from "../adapters/operational-state-store";
import { AdminStateStore } from "../adapters/admin-state-store";

const MAX_REQUEST_BYTES = 16_384;
const ModelSchema = z.string().trim().min(1).max(200);
const EmailAddressSchema = z.email().max(320);

export async function providerTest(request: Request, env: Env): Promise<Response> {
  const form = await readAdminForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;

  const provider = ProviderNameSchema.safeParse(form.get("provider"));
  const model = ModelSchema.safeParse(form.get("model"));
  if (!provider.success || !model.success) {
    return textError("Choose a provider and enter a model identifier.");
  }

  const config = parseRuntimeConfig(env);
  const providerStore = new ProviderConfigStore(env.STATE, initialChoice(config));
  const currentProvider = await providerStore.get();
  const choice: ProviderChoice = {
    provider: provider.data,
    model: model.data,
    promptRevision: currentProvider.active.promptRevision,
  };
  const credentialStore = new EncryptedCredentialStore(
    env.STATE,
    getInstallationSecret(env),
  );
  const credential =
    choice.provider === "workers-ai" ? null : await credentialStore.get(choice.provider);

  try {
    await createOrganizationProvider(choice, {
      ai: env.AI,
      credential,
    }).testConnection();
  } catch (error) {
    await providerStore.recordCandidateTest(choice, false);
    await recordActivity(env, config.DISPATCH_LIMIT, "provider_candidate", "failed");
    const code =
      error instanceof ProviderConnectionError ? error.code : "provider";
    return textError(providerFailureMessage(code), 422);
  }

  await providerStore.recordCandidateTest(choice, true);
  await recordActivity(env, config.DISPATCH_LIMIT, "provider_candidate", "passed");
  return redirectToSetup();
}

export async function providerActivate(request: Request, env: Env): Promise<Response> {
  const form = await readAdminForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;

  const config = parseRuntimeConfig(env);
  try {
    await new ProviderConfigStore(env.STATE, initialChoice(config)).activateTestedCandidate();
  } catch (error) {
    if (error instanceof ProviderActivationError) {
      return textError("Test the candidate successfully before activating it.", 409);
    }
    throw error;
  }
  await recordActivity(env, config.DISPATCH_LIMIT, "provider", "activated");
  await env.STATE.delete("installation:v1");
  return redirectToSetup();
}

export async function emailTest(request: Request, env: Env): Promise<Response> {
  const form = await readAdminForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;

  const recipient = EmailAddressSchema.safeParse(form.get("recipient"));
  const from = EmailAddressSchema.safeParse(form.get("from"));
  if (!recipient.success || !from.success) {
    return textError("Enter a valid sender and recipient email address.");
  }

  const store = new EmailConfigStore(env.STATE);
  try {
    await env.EMAIL.send({
      to: recipient.data,
      from: { email: from.data, name: "Later Gator" },
      subject: "Later Gator email test",
      text: "Later Gator can send intervention-required alerts to this address.",
      html: "<p>Later Gator can send intervention-required alerts to this address.</p>",
    });
    await store.recordTest({
      recipient: recipient.data,
      from: from.data,
      status: "ready",
      deliveryCode: "sent",
    });
    await recordActivity(env, parseRuntimeConfig(env).DISPATCH_LIMIT, "email_test", "sent");
  } catch (error) {
    const code = getErrorCode(error);
    const status = classifyEmailReadiness(code);
    await store.recordTest({
      recipient: recipient.data,
      from: from.data,
      status,
      deliveryCode: code ?? "send_failed",
    });
    await recordActivity(env, parseRuntimeConfig(env).DISPATCH_LIMIT, "email_test", "failed");
    return textError(emailFailureMessage(status), 422);
  }

  return redirectToSetup();
}

export async function emailUnavailable(request: Request, env: Env): Promise<Response> {
  const form = await readAdminForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;
  if (form.get("acknowledgement") !== "alerts_disabled") {
    return textError("Confirm that automatic intervention alerts will be unavailable.");
  }

  await new EmailConfigStore(env.STATE).markUnavailable();
  await recordActivity(
    env,
    parseRuntimeConfig(env).DISPATCH_LIMIT,
    "email",
    "unavailable",
  );
  return redirectToSetup();
}

export async function installationValidate(request: Request, env: Env): Promise<Response> {
  const form = await readAdminForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;

  try {
    await validateInstallation(env, getInstallationSecret(env));
  } catch (error) {
    if (error instanceof InstallationValidationError) {
      return textError(error.message, 422);
    }
    return textError("Installation validation failed.", 422);
  }
  return redirectToSetup();
}

export async function adminStatus(request: Request, env: Env): Promise<Response> {
  const session = await readSetupSession(request, env);
  if (session === null) return new Response(null, { status: 401 });

  const config = parseRuntimeConfig(env);
  const admin = new AdminStateStore(env.STATE, config.DISPATCH_LIMIT);
  const [
    provider,
    email,
    installation,
    credentials,
    onboarding,
    pipeline,
    dispatch,
    registry,
    automation,
    maintenance,
    activity,
  ] = await Promise.all([
    new ProviderConfigStore(env.STATE, initialChoice(config)).get(),
    new EmailConfigStore(env.STATE).get(),
    new KvStateStore(
      env.STATE,
      "installation:v1",
      InstallationStateSchema,
    ).get(),
    new EncryptedCredentialStore(env.STATE, getInstallationSecret(env)).getStatus(),
    new OnboardingStateStore(env.STATE).get(),
    new OperationalStateStore(env.STATE).getPipeline(),
    new OperationalStateStore(env.STATE).getDispatch(),
    new OperationalStateStore(env.STATE).getRegistry(),
    admin.getAutomation(),
    admin.getMaintenance(),
    admin.getActivity(),
  ]);

  return Response.json(
    {
      status: "ok",
      data: {
        provider,
        email,
        installation,
        credentials,
        onboarding,
        pipeline,
        dispatch: {
          leased: Object.keys(dispatch.leases).length,
          lastDiscoveryAt: dispatch.lastDiscoveryAt,
          lastDiscovered: dispatch.lastDiscovered,
          lastEnqueued: dispatch.lastEnqueued,
        },
        registry: {
          seedVersion: registry?.seedVersion ?? null,
          size: registry === null ? 0 : Object.keys(registry.tags).length,
        },
        automation,
        maintenance,
        activity,
      },
    },
    {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function readAdminForm(request: Request): Promise<URLSearchParams | Response> {
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

function providerFailureMessage(code: ProviderConnectionError["code"] | "provider"): string {
  switch (code) {
    case "missing_credential":
      return "Enter the selected provider key before testing.";
    case "authentication":
      return "The selected provider rejected its saved key.";
    case "model":
      return "The selected provider could not use that model identifier.";
    case "rate_limit":
      return "The selected provider is rate limited. Try the test again later.";
    case "invalid_response":
      return "The provider responded, but its structured result was invalid.";
    case "provider":
      return "The provider connection test failed.";
  }
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code.slice(0, 100) : null;
}

function classifyEmailReadiness(code: string | null): EmailConfigState["status"] {
  if (code === "E_SENDER_NOT_VERIFIED" || code === "E_SENDER_DOMAIN_NOT_AVAILABLE") {
    return "needs_domain";
  }
  return "needs_verification";
}

function emailFailureMessage(status: EmailConfigState["status"]): string {
  return status === "needs_domain"
    ? "Cloudflare has not accepted the sender domain yet."
    : "Cloudflare could not deliver the test to the selected verified recipient.";
}

function redirectToSetup(): Response {
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

async function recordActivity(
  env: Env,
  defaultDispatchLimit: number,
  event: string,
  outcome: string,
): Promise<void> {
  await new AdminStateStore(env.STATE, defaultDispatchLimit).recordActivity({
    at: new Date().toISOString(),
    event,
    outcome,
  });
}
