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
  const mcpSecret =
    (await readRotatedMcpSecret(credentialStore)) ?? readMcpSecret(env);
  const mcpUrl =
    mcpSecret === null ? null : `${new URL(request.url).origin}/mcp/${mcpSecret}`;

  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Later Gator setup</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 2rem; }
    main { margin: 0 auto; max-width: 48rem; }
    section { border: 1px solid #8886; border-radius: .75rem; margin: 1rem 0; padding: 1rem; }
    form { display: grid; gap: .75rem; margin-top: 1rem; }
    label { display: grid; gap: .35rem; }
    input, select, button { font: inherit; padding: .65rem; }
    .status { font-weight: 700; }
    .configured { color: #16803b; }
    .missing { color: #a1420b; }
    .danger { border-color: #a1420b; }
  </style>
</head>
<body>
<main>
  <h1>Later Gator setup</h1>
  <p>Enter credentials here. Stored values are encrypted and are never displayed back.</p>
  <p><strong>${pipeline.paused ? "Paused" : pipeline.deferredUntil === null ? "Running" : "Waiting"}</strong> — ${pipelineMessage(pipeline.paused, pipeline.pauseReason, pipeline.deferredUntil)}</p>
  <p>Connected account: ${raindropSnapshot === null ? "unavailable" : `${escapeHtml(raindropSnapshot.name)} (ID ${raindropSnapshot.id.toString()})`}. Pending Unsorted: ${raindropSnapshot?.pending?.toString() ?? "unavailable"}.</p>
  <form method="post" action="/setup/logout"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit">Sign out</button></form>

  <section>
    <h2>Raindrop</h2>
    ${statusLabel(status.raindrop.configured)}
    <form method="post" action="/admin/credentials/raindrop">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Enter or replace Raindrop token
        <input name="credential" type="password" minlength="8" maxlength="4096" required autocomplete="new-password">
      </label>
      <button type="submit">Save Raindrop token</button>
    </form>
  </section>

  <section>
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
  </section>

  <section>
    <h2>Organization provider</h2>
    <p>Active: <strong>${escapeHtml(providerState.active.provider)}</strong> using <code>${escapeHtml(providerState.active.model)}</code>.</p>
    <p>Testing uses only a synthetic “Later Gator” response—never bookmark content.</p>
    <p>OpenAI: ${statusLabel(status.openai.configured)}<br>Anthropic: ${statusLabel(status.anthropic.configured)}</p>
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
  </section>

  <section>
    <h2>Email alerts</h2>
    <p>Status: <strong>${escapeHtml(emailState.status)}</strong>. A successful test requires a Cloudflare Email Sending domain and a verified destination.</p>
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
    <form class="danger" method="post" action="/admin/email/unavailable">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>
        <input name="acknowledgement" type="checkbox" value="alerts_disabled" required>
        Continue without automatic intervention alerts
      </label>
      <button type="submit">Record email unavailable</button>
    </form>
  </section>

  <section>
    <h2>Installation validation</h2>
    ${installationSummary(installationState)}
    <p>This checks bindings, the saved Raindrop token, the active provider, and the recorded email state. It does not change Raindrop.</p>
    <form method="post" action="/admin/installation/validate">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <button type="submit">Validate installation</button>
    </form>
  </section>

  <section>
    <h2>Next</h2>
    <p>Onboarding status: <strong>${escapeHtml(onboardingState.status)}</strong>${onboardingState.currentStep === null ? "" : ` — ${escapeHtml(onboardingState.currentStep)}`}.</p>
    ${
      onboardingState.status === "not_started"
        ? `<form method="post" action="/admin/onboarding/check">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <button type="submit">Check fresh or existing account</button>
    </form>`
        : onboardingState.status === "in_progress"
          ? `<form method="post" action="/admin/onboarding/continue">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <input type="hidden" name="confirmation" value="continue_onboarding">
      <button type="submit">Continue onboarding</button>
    </form>`
          : "<p>Onboarding is complete. Routine organization can now run.</p>"
    }
    <form class="danger" method="post" action="/admin/onboarding/reset">
      <input type="hidden" name="csrfToken" value="${csrfToken}">
      <label>Reset lifecycle state only
        <input name="confirmation" required placeholder="Type RESET">
      </label>
      <button type="submit">Reset onboarding state</button>
    </form>
  </section>

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
    ${
      mcpUrl === null
        ? "<p>MCP path secret is missing or invalid. Configure a random 64-character secret.</p>"
        : `<p>Private MCP URL:</p><input readonly value="${escapeHtml(mcpUrl)}" aria-label="MCP URL">
    <pre>ChatGPT / Claude remote MCP URL: ${escapeHtml(mcpUrl)}</pre>`
    }
    <p>The MCP server exposes context, search, pipeline status, and validated resume only.</p>
    <p><a href="/admin/mcp/context" target="_blank" rel="noreferrer">Test safe MCP context</a></p>
    <form method="post" action="/admin/mcp/rotate"><input type="hidden" name="csrfToken" value="${csrfToken}"><label>Type ROTATE <input name="confirmation" required></label><button type="submit">Rotate MCP path secret</button></form>
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
</main>
</body>
</html>`);
}

export async function login(request: Request, env: Env): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== new URL(request.url).origin) return new Response(null, { status: 403 });

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

function readMcpSecret(env: Env): string | null {
  const value: unknown = (env as Env & { MCP_PATH_SECRET?: unknown }).MCP_PATH_SECRET;
  return typeof value === "string" && value.length === 64 ? value : null;
}

async function readRotatedMcpSecret(
  store: EncryptedCredentialStore,
): Promise<string | null> {
  try {
    return await store.get("mcpPath");
  } catch {
    return null;
  }
}

async function readRaindropSnapshot(
  store: EncryptedCredentialStore,
): Promise<{ id: number; name: string; pending: number | null } | null> {
  try {
    const token = await store.get("raindrop");
    if (token === null) return null;
    const client = new RaindropClient(token);
    const [user, page] = await Promise.all([
      client.getCurrentUser(),
      client.listRaindrops(-1, { page: 0, perPage: 1 }),
    ]);
    return { id: user.id, name: user.fullName, pending: page.totalCount };
  } catch {
    return null;
  }
}

function pipelineMessage(
  paused: boolean,
  reason: string | null,
  deferredUntil: string | null,
): string {
  if (paused) return `Action required: ${reason ?? "check configuration"}.`;
  if (deferredUntil !== null) return `Work resumes after ${deferredUntil}.`;
  return "Bookmarks saved to Unsorted are eligible for organization.";
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

function loginPage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Later Gator login</title></head>
<body><main><h1>Later Gator setup</h1><form method="post" action="/setup/login"><label>Installation secret <input name="secret" type="password" required autocomplete="current-password"></label><button type="submit">Sign in</button></form></main></body></html>`);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
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
