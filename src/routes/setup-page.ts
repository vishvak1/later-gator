import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { EmailConfigStore } from "../adapters/email-config-store";
import { KvStateStore } from "../adapters/kv-state-store";
import { ProviderConfigStore } from "../adapters/provider-config-store";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { parseRuntimeConfig } from "../config";
import {
  InstallationStateSchema,
  type InstallationState,
  type ProviderChoice,
} from "../domain/schemas";
import {
  createSetupSessionCookie,
  getInstallationSecret,
  readSetupSession,
  secretsEqual,
} from "./setup-auth";
import { readBoundedUrlEncodedForm, RequestBodyError } from "./request-body";
import { AdminStateStore } from "../adapters/admin-state-store";
import { OperationalStateStore } from "../adapters/operational-state-store";
import { FOLDER_NAMES } from "../domain/seed";
import { requireSetupMutation } from "./setup-auth";
import { RaindropClient } from "../adapters/raindrop-client";
import { getOrCreateMcpSecret } from "../application/mcp-secret";
import {
  diagnoseRaindropConnection,
  type RaindropConnectionDiagnostic,
} from "../application/raindrop-connection-diagnostic";
import { setupHtmlHeaders } from "./security-headers";

const MAX_LOGIN_BYTES = 4_096;

export async function setupPage(request: Request, env: Env): Promise<Response> {
  const session = await readSetupSession(request, env);
  if (session === null) return loginPage();

  const credentialStore = new EncryptedCredentialStore(
    env.STATE,
    getInstallationSecret(env),
  );
  const config = parseRuntimeConfig(env);
  const adminStore = new AdminStateStore(env.STATE, config.DISPATCH_LIMIT);
  const [
    status,
    providerState,
    emailState,
    installationState,
    onboardingState,
    pipeline,
    dispatch,
    registry,
    automation,
    maintenance,
    activity,
    raindropSnapshot,
  ] = await Promise.all([
    credentialStore.getStatus(),
    new ProviderConfigStore(env.STATE, initialChoice(config)).get(),
    new EmailConfigStore(env.STATE).get(),
    new KvStateStore(
      env.STATE,
      "installation:v1",
      InstallationStateSchema,
    ).get(),
    new OnboardingStateStore(env.STATE).get(),
    new OperationalStateStore(env.STATE).getPipeline(),
    new OperationalStateStore(env.STATE).getDispatch(),
    new OperationalStateStore(env.STATE).getRegistry(),
    adminStore.getAutomation(),
    adminStore.getMaintenance(),
    adminStore.getActivity(),
    readRaindropSnapshot(credentialStore),
  ]);
  const csrfToken = escapeHtml(session.csrfToken);
  const mcpSecret = await getOrCreateMcpSecret(credentialStore);
  const mcpUrl = `${new URL(request.url).origin}/mcp/${mcpSecret}`;
  const setupStep =
    onboardingState.status === "complete"
      ? 4
      : installationState !== null
        ? 3
        : status.raindrop.configured
          ? 2
          : 1;

  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Later Gator setup</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --ink: #18342b;
      --muted: #61756d;
      --line: #dce7e1;
      --paper: #ffffff;
      --canvas: #f2f7f3;
      --gator: #177a52;
      --gator-dark: #0f5b3c;
      --lime: #dff36a;
      --amber: #a65a17;
      --danger: #9f3737;
      --shadow: 0 18px 44px rgba(27, 66, 51, .09);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--canvas); color: var(--ink); }
    a { color: var(--gator-dark); }
    .topbar {
      align-items: center;
      background: rgba(255, 255, 255, .92);
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      padding: .9rem clamp(1rem, 4vw, 3rem);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .brand { align-items: center; display: flex; gap: .75rem; font-weight: 800; letter-spacing: -.02em; }
    .brand-mark {
      align-items: center;
      background: var(--gator);
      border-radius: .8rem;
      color: white;
      display: inline-flex;
      font-size: .85rem;
      height: 2.25rem;
      justify-content: center;
      width: 2.25rem;
    }
    main { margin: 0 auto; max-width: 72rem; padding: clamp(1rem, 4vw, 3rem); }
    .hero {
      background: linear-gradient(135deg, #123f30 0%, #1b7653 72%, #82a93d 140%);
      border: 0;
      border-radius: 1.5rem;
      box-shadow: var(--shadow);
      color: white;
      margin: 0 0 1.25rem;
      overflow: hidden;
      padding: clamp(1.5rem, 5vw, 3rem);
      position: relative;
    }
    .hero::after {
      background: var(--lime);
      border-radius: 50%;
      content: "";
      height: 12rem;
      opacity: .16;
      position: absolute;
      right: -3rem;
      top: -5rem;
      width: 12rem;
    }
    .eyebrow { font-size: .78rem; font-weight: 800; letter-spacing: .12em; margin: 0 0 .5rem; text-transform: uppercase; }
    h1 { font-size: clamp(2rem, 5vw, 3.4rem); letter-spacing: -.05em; line-height: 1; margin: 0; }
    h2 { font-size: 1.15rem; letter-spacing: -.02em; margin: 0 0 .45rem; }
    p { line-height: 1.55; }
    .hero-copy { color: #e8f4ee; max-width: 42rem; }
    .steps { display: grid; gap: .6rem; grid-template-columns: repeat(4, 1fr); margin-top: 1.75rem; position: relative; z-index: 1; }
    .step {
      background: rgba(255, 255, 255, .1);
      border: 1px solid rgba(255, 255, 255, .18);
      border-radius: .9rem;
      color: #dcebe4;
      font-size: .82rem;
      font-weight: 700;
      padding: .75rem;
    }
    .step.done { background: rgba(223, 243, 106, .18); color: white; }
    .step.current { background: var(--lime); border-color: var(--lime); color: #153329; }
    .step-number { display: block; font-size: .7rem; margin-bottom: .2rem; opacity: .72; }
    .summary {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(3, 1fr);
      margin-bottom: 1.25rem;
    }
    .summary-card { background: var(--paper); border: 1px solid var(--line); border-radius: 1rem; padding: 1rem 1.1rem; }
    .summary-label { color: var(--muted); display: block; font-size: .75rem; font-weight: 800; letter-spacing: .08em; margin-bottom: .35rem; text-transform: uppercase; }
    .summary-value { font-size: 1rem; font-weight: 800; }
    .setup-grid, .settings-grid { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    section, details.card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 1.15rem;
      box-shadow: 0 8px 24px rgba(27, 66, 51, .04);
      margin: 0 0 1rem;
      padding: 1.25rem;
    }
    .full { grid-column: 1 / -1; }
    .section-kicker { color: var(--gator); font-size: .72rem; font-weight: 900; letter-spacing: .1em; margin: 0 0 .4rem; text-transform: uppercase; }
    form { display: grid; gap: .75rem; margin-top: 1rem; }
    label { color: var(--ink); display: grid; font-size: .9rem; font-weight: 700; gap: .4rem; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea {
      background: #fbfdfb;
      border: 1px solid #cbdad2;
      border-radius: .7rem;
      color: var(--ink);
      min-width: 0;
      padding: .72rem .8rem;
      width: 100%;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--gator); box-shadow: 0 0 0 3px rgba(23, 122, 82, .12); outline: 0; }
    button, .button {
      background: var(--gator);
      border: 0;
      border-radius: .7rem;
      color: white;
      cursor: pointer;
      font-weight: 800;
      justify-self: start;
      padding: .72rem 1rem;
    }
    button:hover, .button:hover { background: var(--gator-dark); }
    .secondary { background: #e9f2ed; color: var(--gator-dark); }
    .status { border-radius: 999px; display: inline-block; font-size: .76rem; font-weight: 800; padding: .32rem .6rem; }
    .configured { background: #e0f4e7; color: #11613d; }
    .missing { background: #fff0df; color: var(--amber); }
    .connection-problem {
      background: #fff8ed;
      border: 1px solid #f1d2aa;
      border-radius: .8rem;
      color: #71400f;
      margin: .8rem 0 0;
      padding: .75rem .85rem;
    }
    .connection-problem strong { display: block; margin-bottom: .2rem; }
    .danger { background: #fffafa; border-color: #efcccc; }
    .danger button { background: var(--danger); }
    .helper { color: var(--muted); font-size: .88rem; margin: .35rem 0; }
    .connection-row { align-items: center; display: flex; gap: .6rem; }
    .connection-row input { flex: 1; }
    details.card > summary { cursor: pointer; font-weight: 800; list-style: none; }
    details.card > summary::after { color: var(--gator); content: "+"; float: right; font-size: 1.3rem; }
    details.card[open] > summary::after { content: "−"; }
    .settings-title { margin: 2rem 0 1rem; }
    .setup-hidden { display: none; }
    pre { background: #153329; border-radius: .7rem; color: #eff8f2; overflow: auto; padding: .8rem; white-space: pre-wrap; }
    ul { padding-left: 1.25rem; }
    @media (max-width: 760px) {
      .summary, .setup-grid, .settings-grid { grid-template-columns: 1fr; }
      .steps { grid-template-columns: repeat(2, 1fr); }
      .full { grid-column: auto; }
      .steps { gap: .4rem; }
      .topbar { position: static; }
    }
  </style>
  <script src="/setup.js" defer></script>
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="brand-mark">LG</span> Later Gator</div>
  <form method="post" action="/setup/logout"><input type="hidden" name="csrfToken" value="${csrfToken}"><button class="secondary" type="submit">Sign out</button></form>
</header>
<main>
  <section class="hero">
    <p class="eyebrow">${onboardingState.status === "complete" ? "Your bookmark control room" : "Private setup · about five minutes"}</p>
    <h1>${onboardingState.status === "complete" ? "Everything is under control." : "Let’s organize your Raindrop."}</h1>
    <p class="hero-copy">${onboardingState.status === "complete" ? "Review activity, change how Later Gator works, or connect it to your AI assistant." : "Follow the four steps below. Nothing changes in Raindrop until you review the account and press Start onboarding."}</p>
    <div class="steps" aria-label="Setup progress">
      ${progressStep(1, setupStep, "Connect", "Raindrop")}
      ${progressStep(2, setupStep, "Check", "AI and installation")}
      ${progressStep(3, setupStep, "Onboard", "Review and confirm")}
      ${progressStep(4, setupStep, "Organize", "Automatic")}
    </div>
  </section>

  <div class="summary">
    <div class="summary-card"><span class="summary-label">Raindrop account</span><span class="summary-value">${raindropSummary(raindropSnapshot)}</span></div>
    <div class="summary-card"><span class="summary-label">Unsorted bookmarks</span><span class="summary-value">${raindropSnapshot.status === "connected" ? raindropSnapshot.pending?.toString() ?? "—" : "—"}</span></div>
    <div class="summary-card"><span class="summary-label">Automation</span><span class="summary-value">${pipeline.paused ? "Needs attention" : pipeline.deferredUntil === null ? "Ready" : "Waiting safely"}</span></div>
  </div>

  <div class="setup-grid">
  <section>
    <p class="section-kicker">Step 1</p>
    <h2>Raindrop</h2>
    ${statusLabel(status.raindrop.configured)}
    <p class="helper">Use the token from the test account you want to organize. Saving it does not change any bookmarks.</p>
    ${raindropDiagnosticPanel(raindropSnapshot)}
    <form method="post" action="/admin/credentials/raindrop">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>${status.raindrop.configured ? "Replace Raindrop token" : "Raindrop test token"}
        <input name="credential" type="password" minlength="8" maxlength="4096" required autocomplete="new-password">
      </label>
      <button type="submit">${status.raindrop.configured ? "Replace connection" : "Connect Raindrop"}</button>
    </form>
  </section>

  <details class="card">
    <summary>Personal instructions <span class="helper">Optional</span></summary>
    <h2>Instructions</h2>
    <p>Revision ${providerState.active.promptRevision.toString()}. Changes apply to the next bookmark.</p>
    <form method="post" action="/admin/settings/prompt">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Personal instructions
        <textarea name="personalInstructions" maxlength="4000" rows="5">${escapeHtml(providerState.personalInstructions)}</textarea>
      </label>
      <label><input type="checkbox" name="advanced" value="enabled"> Use advanced full-prompt override</label>
      <label>Advanced override
        <textarea name="fullPromptOverride" maxlength="20000" rows="8">${escapeHtml(providerState.fullPromptOverride ?? "")}</textarea>
      </label>
      <label>Type OVERRIDE when enabling the advanced override
        <input name="warning">
      </label>
      <button type="submit">Save instructions</button>
    </form>
    <form method="post" action="/admin/settings/prompt/restore">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Type RESTORE <input name="confirmation" required></label>
      <button type="submit">Restore shipped prompt</button>
    </form>
  </details>

  <section>
    <p class="section-kicker">Step 2</p>
    <h2>Organization provider</h2>
    <p>Active: <strong>${providerName(providerState.active.provider)}</strong></p>
    <p class="helper">Cloudflare Workers AI is free to start and needs no external key. The test uses no bookmark content.</p>
    <p>OpenAI: ${statusLabel(status.openai.configured)}<br>Anthropic: ${statusLabel(status.anthropic.configured)}</p>
    <details>
      <summary>Use OpenAI or Anthropic instead</summary>
    <form method="post" action="/admin/credentials/provider">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Provider
        <select name="provider" required>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>Enter or replace API key
        <input name="credential" type="password" minlength="8" maxlength="4096" required autocomplete="new-password">
      </label>
      <button type="submit">Save provider key</button>
    </form>
    </details>
    <form method="post" action="/admin/provider/test">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Provider to test
        <select name="provider" required>
          <option value="workers-ai">Cloudflare Workers AI</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>Model identifier
        <input name="model" value="${escapeHtml(providerState.active.model)}" maxlength="200" required>
      </label>
      <button type="submit">Test candidate</button>
    </form>
    ${candidatePanel(providerState.candidate, providerState.candidateTestSucceeded, csrfToken)}
    <details>
      <summary>Manage saved external-provider keys</summary>
    <form class="danger" method="post" action="/admin/credentials/provider/remove">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Remove stored key for
        <select name="provider" required>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>Type REMOVE
        <input name="confirmation" required>
      </label>
      <button type="submit">Remove provider key</button>
    </form>
    </details>
  </section>

  <section>
    <p class="section-kicker">Step 2</p>
    <h2>Email alerts</h2>
    <p>Status: <strong>${emailStatusName(emailState.status)}</strong></p>
    <p class="helper">Email is optional for testing. It is only used when Later Gator needs your help.</p>
    <details>
      <summary>I have a Cloudflare email domain</summary>
    <form method="post" action="/admin/email/test">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Sender on your Cloudflare Email Sending domain
        <input name="from" type="email" maxlength="320" value="${escapeHtml(emailState.from ?? "")}" required>
      </label>
      <label>Verified recipient you control
        <input name="recipient" type="email" maxlength="320" value="${escapeHtml(emailState.recipient ?? "")}" required>
      </label>
      <button type="submit">Send test email</button>
    </form>
    </details>
    <form method="post" action="/admin/email/unavailable">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>
        <input name="acknowledgement" type="checkbox" value="alerts_disabled" required>
        Continue without automatic intervention alerts
      </label>
      <button class="secondary" type="submit">Continue without email alerts</button>
    </form>
  </section>

  <section>
    <p class="section-kicker">Step 2</p>
    <h2>Installation validation</h2>
    ${installationSummary(installationState)}
    <p>This checks bindings, the saved Raindrop token, the active provider, and the recorded email state. It does not change Raindrop.</p>
    <form method="post" action="/admin/installation/validate">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <button type="submit">Validate installation</button>
    </form>
  </section>

  <section class="full">
    <p class="section-kicker">Step 3</p>
    <h2>Review and start onboarding</h2>
    <p>Onboarding status: <strong>${escapeHtml(onboardingState.status)}</strong>${onboardingState.currentStep === null ? "" : ` — ${escapeHtml(onboardingState.currentStep)}`}.</p>
    ${
      onboardingState.status === "not_started"
        ? `<form method="post" action="/admin/onboarding/check">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <button type="submit">Review my Raindrop account</button>
    </form>`
        : onboardingState.status === "in_progress"
          ? `<form method="post" action="/admin/onboarding/continue">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <input type="hidden" name="confirmation" value="continue_onboarding">
      <button type="submit">Continue onboarding</button>
    </form>`
          : "<p>Onboarding is complete. Routine organization can now run.</p>"
    }
    ${
      onboardingState.status === "complete"
        ? `<form class="danger" method="post" action="/admin/onboarding/reset">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Reset lifecycle state only
        <input name="confirmation" required placeholder="Type RESET">
      </label>
      <button type="submit">Reset onboarding state</button>
    </form>`
        : ""
    }
  </section>
  </div>

  ${
    onboardingState.status === "complete"
      ? ""
      : `<section class="full">
    <p class="section-kicker">After onboarding</p>
    <h2>Your controls will appear here</h2>
    <p class="helper">Once setup is complete, this page becomes your control room for backfill, pause and resume, AI choices, activity, and the one-click ChatGPT or Claude connection address.</p>
  </section>`
  }
  <h2 class="settings-title ${onboardingState.status === "complete" ? "" : "setup-hidden"}">Controls and settings</h2>
  <div class="settings-grid ${onboardingState.status === "complete" ? "" : "setup-hidden"}">
  <section>
    <h2>Automation</h2>
    <p>Mode: <strong>${escapeHtml(pipeline.mode)}</strong>. Leased items: ${Object.keys(dispatch.leases).length.toString()}. Last discovery: ${escapeHtml(dispatch.lastDiscoveryAt ?? "not yet")}.</p>
    <p>Deferral: ${escapeHtml(pipeline.deferredUntil ?? "none")}. Last registry resync: ${escapeHtml(maintenance.lastRegistryResyncAt ?? "not yet")}.</p>
    <form method="post" action="/admin/settings/automation">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Discovery batch limit (1–50)
        <input name="dispatchLimit" type="number" min="1" max="50" value="${automation.dispatchLimit.toString()}" required>
      </label>
      <button type="submit">Save batch limit</button>
    </form>
    <form method="post" action="/admin/automation/pause"><input type="hidden" name="csrfToken" value="${csrfToken}"><label>Type PAUSE <input name="confirmation" required></label><button type="submit">Pause</button></form>
    <form method="post" action="/admin/automation/resume"><input type="hidden" name="csrfToken" value="${csrfToken}"><label>Type RESUME <input name="confirmation" required></label><button type="submit">Validate and resume</button></form>
    <form method="post" action="/admin/backfill/start"><input type="hidden" name="csrfToken" value="${csrfToken}"><label>Type START <input name="confirmation" required></label><button type="submit">Start faster backfill</button></form>
    <form method="post" action="/admin/backfill/continue"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit">Continue next backfill group</button></form>
    <form method="post" action="/admin/backfill/stop"><input type="hidden" name="csrfToken" value="${csrfToken}"><label>Type STOP <input name="confirmation" required></label><button type="submit">Stop backfill dispatch</button></form>
  </section>

  <section>
    <h2>Search and MCP</h2>
    <p class="helper">Later Gator created this private connection address automatically. You never need to manage its machine secret.</p>
    <div class="connection-row"><input id="mcp-url" readonly value="${escapeHtml(mcpUrl)}" aria-label="MCP connection address"><button type="button" data-copy-target="mcp-url">Copy connection address</button></div>
    <p>The MCP server exposes context, search, pipeline status, and validated resume only.</p>
    <p><a href="/admin/mcp/context" target="_blank" rel="noreferrer">Test safe MCP context</a></p>
    <form method="post" action="/admin/mcp/rotate"><input type="hidden" name="csrfToken" value="${csrfToken}"><input type="hidden" name="confirmation" value="ROTATE"><button class="secondary" type="submit">Generate a new connection address</button></form>
  </section>

  <section>
    <h2>Folders and tags</h2>
    <p>Seed version: ${escapeHtml(onboardingState.seedVersion ?? "not installed")}. Registry tags: ${(registry === null ? 0 : Object.keys(registry.tags).length).toString()}.</p>
    <ul>${FOLDER_NAMES.map((name) => `<li>${escapeHtml(name)} — ${onboardingState.folderIds[name]?.toString() ?? "missing"}</li>`).join("")}</ul>
    <p>Highest-use tags: ${registry === null ? "none" : escapeHtml(topTags(registry.tags))}</p>
    <form method="post" action="/admin/registry/rebuild"><input type="hidden" name="csrfToken" value="${csrfToken}"><label>Type REBUILD <input name="confirmation" required></label><button type="submit">Rebuild registry from Raindrop</button></form>
  </section>

  <section>
    <h2>Recent activity</h2>
    <ul>${activity.entries.length === 0 ? "<li>No activity yet.</li>" : activity.entries.map((entry) => `<li>${escapeHtml(entry.at)} — ${escapeHtml(entry.event)}: ${escapeHtml(entry.outcome)}${entry.bookmarkId === undefined ? "" : ` (bookmark ${entry.bookmarkId.toString()})`}</li>`).join("")}</ul>
  </section>

  <section>
    <h2>Maintenance and uninstall</h2>
    <p>Replace credentials above, rerun the account check after a lifecycle reset, or rebuild the registry here. To uninstall, disable Cron and Queue triggers, remove the Worker, Queue, and KV namespace in Cloudflare, then revoke the Later Gator Raindrop token and any provider keys.</p>
  </section>
  </div>
</main>
</body>
</html>`);
}

export async function login(request: Request, env: Env): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const isLocalDevelopment =
    (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") &&
    parseRuntimeConfig(env).ENVIRONMENT === "development";
  if (requestOrigin !== requestUrl.origin && !isLocalDevelopment) {
    return new Response(null, { status: 403 });
  }

  let body: URLSearchParams;
  try {
    body = await readBoundedUrlEncodedForm(request, MAX_LOGIN_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return new Response(error.message, {
        status: error.status,
        headers: { "cache-control": "no-store" },
      });
    }
    throw error;
  }

  const supplied = body.get("secret");
  if (
    typeof supplied !== "string" ||
    !(await secretsEqual(supplied, getInstallationSecret(env)))
  ) {
    return htmlResponse("<!doctype html><title>Unauthorized</title><p>Unauthorized</p>", 401);
  }

  const cookie = await createSetupSessionCookie(env);
  return new Response(null, {
    status: 303,
    headers: { location: "/setup", "set-cookie": cookie, "cache-control": "no-store" },
  });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  let body: URLSearchParams;
  try {
    body = await readBoundedUrlEncodedForm(request, MAX_LOGIN_BYTES);
  } catch {
    return new Response(null, { status: 400 });
  }
  const auth = await requireSetupMutation(request, env, body.get("csrfToken"));
  if (auth instanceof Response) return auth;
  return new Response(null, {
    status: 303,
    headers: {
      location: "/setup",
      "set-cookie":
        "later_gator_setup=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
      "cache-control": "no-store",
    },
  });
}

function statusLabel(configured: boolean): string {
  return configured
    ? '<span class="status configured">Configured</span>'
    : '<span class="status missing">Missing</span>';
}

function candidatePanel(
  candidate: ProviderChoice | null,
  succeeded: boolean,
  csrfToken: string,
): string {
  if (candidate === null) return "<p>No provider candidate has been tested yet.</p>";
  const outcome = succeeded ? "Test passed" : "Test failed";
  const activation = succeeded
    ? `<form method="post" action="/admin/provider/activate">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <button type="submit">Activate candidate for the next bookmark</button>
    </form>`
    : "";
  return `<p>Candidate: <strong>${escapeHtml(candidate.provider)}</strong> using <code>${escapeHtml(candidate.model)}</code> — ${outcome}.</p>${activation}`;
}

function installationSummary(state: InstallationState | null): string {
  if (state === null) return '<p class="status missing">Not validated</p>';
  return `<p class="status configured">Validated for Raindrop user ${state.raindropUserId.toString()}, ${escapeHtml(state.provider)} / ${escapeHtml(state.model)}. Email: ${escapeHtml(state.emailStatus)}.</p>`;
}

function initialChoice(config: ReturnType<typeof parseRuntimeConfig>): ProviderChoice {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    promptRevision: 1,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function readRaindropSnapshot(
  store: EncryptedCredentialStore,
): Promise<RaindropSnapshot> {
  try {
    const token = await store.get("raindrop");
    if (token === null) return { status: "not_configured" };
    const client = new RaindropClient(token);
    const [user, page] = await Promise.all([
      client.getCurrentUser(),
      client.listRaindrops(-1, { page: 0, perPage: 1 }),
    ]);
    return {
      status: "connected",
      id: user.id,
      name: user.fullName,
      pending: page.totalCount,
    };
  } catch (error) {
    return { status: "error", diagnostic: diagnoseRaindropConnection(error) };
  }
}

type RaindropSnapshot =
  | { status: "not_configured" }
  | {
      status: "connected";
      id: number;
      name: string;
      pending: number | null;
    }
  | { status: "error"; diagnostic: RaindropConnectionDiagnostic };

function raindropSummary(snapshot: RaindropSnapshot): string {
  if (snapshot.status === "connected") return escapeHtml(snapshot.name);
  if (snapshot.status === "error") return escapeHtml(snapshot.diagnostic.summary);
  return "Not connected";
}

function raindropDiagnosticPanel(snapshot: RaindropSnapshot): string {
  if (snapshot.status !== "error") return "";
  return `<div class="connection-problem" role="alert"><strong>${escapeHtml(snapshot.diagnostic.summary)}</strong>${escapeHtml(snapshot.diagnostic.message)}</div>`;
}

function topTags(
  tags: Record<string, { count: number }>,
): string {
  return Object.entries(tags)
    .sort(([, left], [, right]) => right.count - left.count)
    .slice(0, 10)
    .map(([name, entry]) => `${name} (${entry.count.toString()})`)
    .join(", ");
}

function progressStep(
  index: number,
  current: number,
  label: string,
  description: string,
): string {
  const state = index < current ? "done" : index === current ? "current" : "";
  return `<div class="step ${state}"><span class="step-number">0${index.toString()}</span>${escapeHtml(label)}<br><span>${escapeHtml(description)}</span></div>`;
}

function providerName(provider: ProviderChoice["provider"]): string {
  if (provider === "workers-ai") return "Cloudflare Workers AI";
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function emailStatusName(status: string): string {
  if (status === "ready") return "Ready";
  if (status === "unavailable") return "Continuing without email";
  return "Not decided yet";
}

function loginPage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Later Gator login</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body {
      align-items: center;
      background: radial-gradient(circle at 80% 10%, #dff36a 0, #dff36a 9rem, transparent 9.1rem), linear-gradient(145deg, #eef6f0, #f8faf7);
      color: #18342b;
      display: grid;
      margin: 0;
      min-height: 100vh;
      padding: 1.25rem;
    }
    main { margin: auto; max-width: 28rem; width: 100%; }
    .mark { align-items: center; background: #177a52; border-radius: 1rem; color: white; display: flex; font-weight: 900; height: 3rem; justify-content: center; margin-bottom: 1.2rem; width: 3rem; }
    .card { background: white; border: 1px solid #dce7e1; border-radius: 1.4rem; box-shadow: 0 24px 60px rgba(27, 66, 51, .12); padding: clamp(1.5rem, 6vw, 2.5rem); }
    .eyebrow { color: #177a52; font-size: .76rem; font-weight: 900; letter-spacing: .12em; margin: 0 0 .5rem; text-transform: uppercase; }
    h1 { font-size: 2.2rem; letter-spacing: -.05em; line-height: 1; margin: 0; }
    p { color: #61756d; line-height: 1.55; }
    form { display: grid; gap: .8rem; margin-top: 1.5rem; }
    label { display: grid; font-size: .9rem; font-weight: 800; gap: .4rem; }
    input { border: 1px solid #cbdad2; border-radius: .75rem; font: inherit; padding: .85rem; width: 100%; }
    input:focus { border-color: #177a52; box-shadow: 0 0 0 3px rgba(23, 122, 82, .12); outline: 0; }
    button { background: #177a52; border: 0; border-radius: .75rem; color: white; cursor: pointer; font: inherit; font-weight: 900; padding: .85rem; }
    .note { font-size: .82rem; margin-bottom: 0; }
  </style>
</head>
<body>
<main>
  <div class="card">
    <div class="mark">LG</div>
    <p class="eyebrow">Your private bookmark assistant</p>
    <h1>Welcome to Later Gator.</h1>
    <p>Enter the setup password you chose during Cloudflare deployment.</p>
    <form method="post" action="/setup/login">
      <label>Setup password
        <input name="secret" type="password" minlength="10" required autocomplete="current-password" autofocus>
      </label>
      <button type="submit">Open Later Gator</button>
    </form>
    <p class="note">Your password stays between this browser and your Cloudflare Worker.</p>
  </div>
</main>
</body>
</html>`);
}

export function setupScript(): Response {
  return new Response(
    `document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-copy-target]")
    : null;
  if (!(button instanceof HTMLButtonElement)) return;
  const targetId = button.dataset.copyTarget;
  const target = targetId === undefined ? null : document.getElementById(targetId);
  if (!(target instanceof HTMLInputElement)) return;
  try {
    await navigator.clipboard.writeText(target.value);
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1800);
  } catch {
    target.focus();
    target.select();
    button.textContent = "Press Command-C";
  }
});`,
    {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: setupHtmlHeaders(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ),
  });
}
