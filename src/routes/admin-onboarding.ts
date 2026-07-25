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
import { setupHtmlHeaders } from "./security-headers";

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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Confirm Later Gator onboarding</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { background: #f2f7f3; color: #18342b; margin: 0; min-height: 100vh; padding: clamp(1rem, 5vw, 3rem); }
    main { margin: 0 auto; max-width: 42rem; }
    .brand { align-items: center; display: flex; font-weight: 900; gap: .7rem; margin-bottom: 1.5rem; }
    .mark { align-items: center; background: #177a52; border-radius: .8rem; color: white; display: inline-flex; height: 2.4rem; justify-content: center; width: 2.4rem; }
    .card { background: white; border: 1px solid #dce7e1; border-radius: 1.4rem; box-shadow: 0 20px 55px rgba(27, 66, 51, .1); overflow: hidden; }
    .head { background: linear-gradient(135deg, #123f30, #1b7653); color: white; padding: clamp(1.5rem, 5vw, 2.5rem); }
    .eyebrow { color: #dff36a; font-size: .76rem; font-weight: 900; letter-spacing: .12em; margin: 0 0 .55rem; text-transform: uppercase; }
    h1 { font-size: clamp(2rem, 6vw, 3rem); letter-spacing: -.05em; line-height: 1; margin: 0; }
    .content { padding: clamp(1.5rem, 5vw, 2.5rem); }
    .account { background: #edf6f0; border-radius: 1rem; display: grid; gap: .8rem; grid-template-columns: repeat(2, 1fr); margin-bottom: 1.2rem; padding: 1rem; }
    .label { color: #61756d; display: block; font-size: .72rem; font-weight: 900; letter-spacing: .08em; margin-bottom: .2rem; text-transform: uppercase; }
    .warning { background: #fff4e6; border: 1px solid #f0d0a9; border-radius: 1rem; padding: .2rem 1rem; }
    li { line-height: 1.5; margin: .55rem 0; }
    .actions { align-items: center; display: flex; gap: 1rem; margin-top: 1.5rem; }
    button { background: #177a52; border: 0; border-radius: .75rem; color: white; cursor: pointer; font: inherit; font-weight: 900; padding: .85rem 1.1rem; }
    a { color: #0f5b3c; font-weight: 800; }
    @media (max-width: 520px) { .account { grid-template-columns: 1fr; } .actions { align-items: stretch; flex-direction: column; } }
  </style>
</head>
<body>
<main>
  <div class="brand"><span class="mark">LG</span> Later Gator</div>
  <div class="card">
    <div class="head">
      <p class="eyebrow">Final review · nothing has changed yet</p>
      <h1>Ready to organize this account?</h1>
    </div>
    <div class="content">
      <div class="account">
        <div><span class="label">Raindrop account</span><strong>${escapeHtml(check.raindropUserName)}</strong></div>
        <div><span class="label">Detected</span><strong>${check.bookmarkCount.toString()} bookmarks · ${check.userFolderCount.toString()} folders</strong></div>
      </div>
      <div class="${check.mode === "existing" ? "warning" : ""}">${warning}</div>
      <h2>What Later Gator will do</h2>
      <ol>${actionItems}</ol>
      <div class="actions">
        <form method="post" action="/admin/onboarding/start">
          <input type="hidden" name="csrfToken" value="${csrfToken}">
          <input type="hidden" name="confirmation" value="start_onboarding">
          <button type="submit">Start onboarding</button>
        </form>
        <a href="/setup">Go back without changing anything</a>
      </div>
    </div>
  </div>
</main>
</body>
</html>`);
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
    headers: setupHtmlHeaders(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ),
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
