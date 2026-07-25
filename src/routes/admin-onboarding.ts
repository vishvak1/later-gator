import {
  checkOnboardingAccount,
  continueOnboarding,
  OnboardingAccountMismatchError,
  startOnboarding,
} from "../application/onboarding";
import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { KvStateStore } from "../adapters/kv-state-store";
import { OnboardingStateStore, emptyOnboardingState } from "../adapters/onboarding-state-store";
import { RaindropClient } from "../adapters/raindrop-client";
import { InstallationStateSchema } from "../domain/schemas";
import { readBoundedUrlEncodedForm, RequestBodyError } from "./request-body";
import { getInstallationSecret, requireSetupMutation } from "./setup-auth";

const MAX_REQUEST_BYTES = 8_192;

export async function onboardingCheck(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;

  const raindrop = await createRaindrop(env);
  if (raindrop instanceof Response) return raindrop;
  const check = await checkOnboardingAccount(raindrop);
  const csrfToken = escapeHtml(authorized.csrfToken);
  const actionItems = check.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  const warning =
    check.mode === "existing"
      ? "<p><strong>This resets the organization:</strong> bookmarks move to Unsorted, bookmark tags are cleared, and verified-empty owned folders are deleted.</p>"
      : "<p>This account is empty. Later Gator will only create its folders and seed registry.</p>";

  return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm Later Gator onboarding</title></head>
<body><main>
  <h1>Confirm ${escapeHtml(check.mode)} onboarding</h1>
  <p>Connected Raindrop account: ${escapeHtml(check.raindropUserName)} (ID ${check.raindropUserId.toString()}).</p>
  <p>Found ${check.bookmarkCount.toString()} non-Trash bookmarks and ${check.userFolderCount.toString()} owned folders.</p>
  ${warning}
  <ol>${actionItems}</ol>
  <form method="post" action="/admin/onboarding/start">
    <input type="hidden" name="csrfToken" value="${csrfToken}">
    <input type="hidden" name="confirmation" value="start_onboarding">
    <button type="submit">Start onboarding</button>
  </form>
  <p><a href="/setup">Cancel</a></p>
</main></body></html>`);
}

export async function onboardingStart(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;
  if (form.get("confirmation") !== "start_onboarding") {
    return textError("Explicit onboarding confirmation is required.");
  }

  const installation = await new KvStateStore(
    env.STATE,
    "installation:v1",
    InstallationStateSchema,
  ).get();
  if (installation === null) return textError("Validate the installation first.", 409);
  if (installation.emailStatus !== "ready" && installation.emailStatus !== "unavailable") {
    return textError("Finish email setup or explicitly continue without alerts.", 409);
  }

  const raindrop = await createRaindrop(env);
  if (raindrop instanceof Response) return raindrop;
  try {
    await startOnboarding(env.STATE, raindrop, installation.raindropUserId);
    await runOnboardingChunks(env, raindrop);
  } catch (error) {
    if (error instanceof OnboardingAccountMismatchError) {
      return textError(error.message, 409);
    }
    throw error;
  }
  return redirectToSetup();
}

export async function onboardingContinue(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;
  if (form.get("confirmation") !== "continue_onboarding") {
    return textError("Explicit onboarding continuation is required.");
  }

  const raindrop = await createRaindrop(env);
  if (raindrop instanceof Response) return raindrop;
  try {
    await runOnboardingChunks(env, raindrop);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Raindrop account does not match the onboarding account"
    ) {
      return textError(error.message, 409);
    }
    throw error;
  }
  return redirectToSetup();
}

async function runOnboardingChunks(
  env: Env,
  raindrop: RaindropClient,
): Promise<void> {
  const initial = await new OnboardingStateStore(env.STATE).get();
  const chunkLimit = initial.mode === "fresh" ? 12 : 10;
  for (let chunk = 0; chunk < chunkLimit; chunk += 1) {
    const state = await continueOnboarding(env.STATE, raindrop, env.SEED_VERSION);
    if (state.status === "complete") return;
  }
}

export async function onboardingReset(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const authorized = await requireSetupMutation(request, env, form.get("csrfToken"));
  if (authorized instanceof Response) return authorized;
  if (form.get("confirmation") !== "RESET") {
    return textError("Type RESET to reset onboarding state.");
  }
  const current = await new OnboardingStateStore(env.STATE).get();
  await new OnboardingStateStore(env.STATE).put({
    ...emptyOnboardingState(),
    revision: current.revision + 1,
  });
  return redirectToSetup();
}

async function createRaindrop(env: Env): Promise<RaindropClient | Response> {
  const token = await new EncryptedCredentialStore(
    env.STATE,
    getInstallationSecret(env),
  ).get("raindrop");
  return token === null
    ? textError("Enter the Raindrop token first.", 409)
    : new RaindropClient(token);
}

async function readForm(request: Request): Promise<URLSearchParams | Response> {
  try {
    return await readBoundedUrlEncodedForm(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return textError(error.message, error.status);
    throw error;
  }
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

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
