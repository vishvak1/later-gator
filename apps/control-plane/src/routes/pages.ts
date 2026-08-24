/** Escapes the only dynamic values inserted into server-rendered control-plane HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Converts an internal snake-case status into concise presentation copy. */
function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

/** Wraps a control-plane view in the shared responsive application shell. */
function page(title: string, content: string, layout: "auth" | "dashboard" = "dashboard"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#102c24">
    <title>${escapeHtml(title)} · Later Gator</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-synthesis: none;
        --ink: #112a23;
        --muted: #64756f;
        --line: #dfe7e2;
        --surface: #ffffff;
        --surface-soft: #f4f7f5;
        --brand: #123c30;
        --brand-hover: #0d3026;
        --accent: #d7f56e;
        --success: #137a50;
        --warning: #9a5b16;
        --danger: #a43e3e;
        --shadow: 0 24px 70px rgba(17, 42, 35, .10);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at 85% 0%, rgba(215, 245, 110, .24), transparent 24rem),
          linear-gradient(180deg, #f8faf8 0%, #eef3ef 100%);
        color: var(--ink);
      }
      a { color: inherit; }
      button, input { font: inherit; }
      .shell { width: min(72rem, calc(100% - 2rem)); margin: 0 auto; padding: 1.25rem 0 3rem; }
      .shell--auth { min-height: 100vh; display: grid; align-content: center; padding-block: 2rem; }
      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 2.5rem; }
      .brand { display: inline-flex; align-items: center; gap: .75rem; text-decoration: none; font-weight: 780; letter-spacing: -.025em; }
      .brand-mark {
        display: grid;
        width: 2.25rem;
        height: 2.25rem;
        place-items: center;
        border-radius: .72rem;
        background: var(--brand);
        color: var(--accent);
        font-size: 1rem;
        box-shadow: 0 7px 18px rgba(18, 60, 48, .18);
      }
      .eyebrow { margin: 0 0 .7rem; color: var(--success); font-size: .72rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      h1, h2, h3, p { margin-top: 0; }
      h1 { margin-bottom: .8rem; max-width: 14ch; font-size: clamp(2.35rem, 6vw, 4.6rem); line-height: .98; letter-spacing: -.065em; }
      h2 { margin-bottom: .45rem; font-size: 1.12rem; letter-spacing: -.025em; }
      h3 { margin-bottom: .35rem; font-size: .95rem; }
      p { color: var(--muted); line-height: 1.65; }
      strong { color: var(--ink); }
      .auth-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(19rem, .85fr); overflow: hidden; border: 1px solid rgba(18, 60, 48, .12); border-radius: 1.5rem; background: var(--surface); box-shadow: var(--shadow); }
      .auth-intro { padding: clamp(2rem, 6vw, 4.5rem); background: var(--brand); color: #fff; }
      .auth-intro .eyebrow, .auth-intro p { color: #b8cdc5; }
      .auth-intro h1, .auth-intro strong { color: #fff; }
      .auth-card { display: flex; flex-direction: column; justify-content: center; padding: clamp(2rem, 5vw, 3.75rem); }
      .auth-card h2 { font-size: 1.55rem; }
      .privacy-list { display: grid; gap: .9rem; margin: 2rem 0 0; padding: 0; list-style: none; }
      .privacy-list li { display: grid; grid-template-columns: 1.7rem 1fr; gap: .75rem; align-items: start; color: #dce8e3; line-height: 1.5; }
      .privacy-list span { display: grid; width: 1.7rem; height: 1.7rem; place-items: center; border-radius: 50%; background: rgba(215, 245, 110, .13); color: var(--accent); font-weight: 800; }
      .button {
        display: inline-flex;
        min-height: 2.85rem;
        align-items: center;
        justify-content: center;
        gap: .55rem;
        border: 1px solid transparent;
        border-radius: .75rem;
        padding: .72rem 1rem;
        background: var(--brand);
        color: #fff;
        font-weight: 750;
        text-decoration: none;
        cursor: pointer;
        transition: transform .15s ease, background .15s ease, border-color .15s ease;
      }
      .button:hover { background: var(--brand-hover); transform: translateY(-1px); }
      .button--secondary { border-color: var(--line); background: var(--surface); color: var(--ink); }
      .button--secondary:hover { border-color: #b9c9c0; background: var(--surface-soft); }
      .button--danger { border-color: #efd2d2; background: #fff8f8; color: var(--danger); }
      .button--danger:hover { border-color: #e1b3b3; background: #fff2f2; }
      .button--wide { width: 100%; }
      .fine-print { margin: 1rem 0 0; font-size: .8rem; }
      .hero { display: flex; align-items: end; justify-content: space-between; gap: 2rem; margin: 0 0 2rem; }
      .hero h1 { max-width: none; margin-bottom: 0; font-size: clamp(2.25rem, 5vw, 3.8rem); }
      .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(17rem, .8fr); gap: 1.25rem; align-items: start; }
      .stack { display: grid; gap: 1.25rem; }
      .card { border: 1px solid var(--line); border-radius: 1rem; padding: clamp(1.2rem, 3vw, 1.65rem); background: rgba(255, 255, 255, .94); box-shadow: 0 12px 36px rgba(17, 42, 35, .05); }
      .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
      .card-header p { margin-bottom: 0; }
      .status { display: inline-flex; flex: 0 0 auto; align-items: center; gap: .45rem; border-radius: 999px; padding: .38rem .65rem; background: #e8f6ee; color: var(--success); font-size: .75rem; font-weight: 800; text-transform: capitalize; }
      .status::before { width: .45rem; height: .45rem; border-radius: 50%; background: currentColor; content: ""; }
      .status--pending { background: #fff3df; color: var(--warning); }
      .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .7rem; margin: 1.35rem 0; }
      .metric { min-width: 0; border: 1px solid var(--line); border-radius: .8rem; padding: .9rem; background: var(--surface-soft); }
      .metric-label { display: block; margin-bottom: .3rem; color: var(--muted); font-size: .7rem; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
      .metric-value { display: block; overflow: hidden; font-weight: 800; text-overflow: ellipsis; text-transform: capitalize; white-space: nowrap; }
      .notice { margin: 1rem 0; border: 1px solid #d9e9df; border-radius: .8rem; padding: .9rem 1rem; background: #f0f8f3; color: #476158; font-size: .88rem; line-height: 1.55; }
      .notice--warning { border-color: #ecd6b9; background: #fff8ec; color: #7d5427; }
      .choice { display: grid; grid-template-columns: auto 1fr; gap: .35rem .7rem; margin: .7rem 0; border: 1px solid var(--line); border-radius: .85rem; padding: 1rem; cursor: pointer; }
      .choice:hover { border-color: #b7cabf; background: var(--surface-soft); }
      .choice input { margin-top: .18rem; accent-color: var(--brand); }
      .choice small { grid-column: 2; color: var(--muted); line-height: 1.5; }
      .actions { display: flex; flex-wrap: wrap; gap: .7rem; margin-top: 1.1rem; }
      .release-list { margin: 1rem 0 0; padding: 0; list-style: none; }
      .release-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; padding: .72rem 0; border-top: 1px solid var(--line); color: var(--muted); font-size: .86rem; }
      .release-list strong { overflow: hidden; text-overflow: ellipsis; }
      .managed { position: relative; overflow: hidden; border-color: #d2df9e; background: linear-gradient(145deg, #f8fce9, #fff); }
      .managed::after { position: absolute; width: 7rem; height: 7rem; right: -2.5rem; bottom: -3rem; border-radius: 50%; background: rgba(215, 245, 110, .45); content: ""; }
      .managed > * { position: relative; z-index: 1; }
      .managed-mark { display: grid; width: 2.35rem; height: 2.35rem; margin-bottom: 1.2rem; place-items: center; border-radius: .75rem; background: var(--brand); color: var(--accent); font-weight: 900; }
      .danger { margin-top: 1.1rem; padding-top: 1.1rem; border-top: 1px solid var(--line); }
      .danger p { font-size: .85rem; }
      form { margin: 0; }
      @media (max-width: 760px) {
        .auth-grid, .dashboard-grid { grid-template-columns: 1fr; }
        .auth-intro { padding-bottom: 2.5rem; }
        .hero { display: block; }
        .hero .actions { margin-top: 1.25rem; }
        .metrics { grid-template-columns: 1fr; }
        .topbar { margin-bottom: 1.8rem; }
      }
      @media (prefers-reduced-motion: reduce) { .button { transition: none; } }
    </style>
  </head>
  <body><main class="shell shell--${layout}">${content}</main></body>
</html>`;
}

/** Renders the public identity entry point without asking for deployment authority. */
export function renderSignedOutPage(): string {
  return page(
    "Sign in",
    `<div class="auth-grid">
       <section class="auth-intro">
         <div class="brand"><span class="brand-mark">LG</span><span>Later Gator</span></div>
         <p class="eyebrow" style="margin-top:3.5rem">Your cloud. Your library.</p>
         <h1>Bookmarks that stay yours.</h1>
         <p>Run a private, AI-organized bookmark library in your own Cloudflare account.</p>
         <ul class="privacy-list">
           <li><span>✓</span><div><strong>Private by architecture</strong><br>Your content never enters the Later Gator control plane.</div></li>
           <li><span>✓</span><div><strong>Managed for you</strong><br>Safe runtime releases install automatically.</div></li>
           <li><span>✓</span><div><strong>Portable by design</strong><br>Your bookmarks live in your personal D1 database.</div></li>
         </ul>
       </section>
       <section class="auth-card">
         <p class="eyebrow">Welcome</p>
         <h2>Manage your installation</h2>
         <p>Sign in to create, open, or review the health of your personal Later Gator.</p>
         <a class="button button--wide" href="/auth/access">Continue with Cloudflare <span aria-hidden="true">→</span></a>
         <p class="fine-print">Identity access is separate from the Cloudflare permissions used to install your runtime.</p>
         <p class="fine-print">Your bookmark content, thumbnails, AI settings, and provider keys stay in your personal Worker.</p>
       </section>
     </div>`,
    "auth",
  );
}

/** Renders the first authenticated shell before installation provisioning exists. */
export function renderDashboard(
  csrfToken: string,
  installation: {
    status: string;
    storageMode: "kv" | "r2";
    safeErrorCode: string | null;
    installedRelease: string | null;
    desiredRelease: string;
    updateStatus: string;
    workerOrigin: string | null;
    runtimeHealthStatus: "unknown" | "ready" | "unavailable";
    authorizationActive: boolean;
  } | null,
  releases: {
    release: string;
    state: string;
    safeErrorCode: string | null;
    startedAt: number;
    completedAt: number | null;
  }[] = [],
): string {
  const releaseHistory = releases.length === 0
    ? `<p class="fine-print">No managed releases have been installed yet.</p>`
    : `<ul class="release-list">${releases.map((release) =>
      `<li><strong>Runtime ${escapeHtml(release.release)}</strong><span>${escapeHtml(statusLabel(release.state))}${
        release.safeErrorCode === null ? "" : ` · ${escapeHtml(release.safeErrorCode)}`
      }</span></li>`
    ).join("")}</ul>`;
  const runtimeMissing = installation?.status === "ready" &&
    installation.runtimeHealthStatus === "unavailable";
  const isReady = installation?.status === "ready" &&
    installation.runtimeHealthStatus === "ready" &&
    installation.workerOrigin !== null;
  const managedUpdateNotice = installation === null
    ? `<div class="notice"><strong>Managed updates start after setup</strong><br>Connect Cloudflare and create your personal runtime to enable managed releases.</div>`
    : installation.authorizationActive
      ? runtimeMissing
        ? `<div class="notice notice--warning"><strong>Runtime Worker missing</strong><br>Automatic updates are paused until the Worker is repaired.</div>`
        : `<div class="notice"><strong>Automatic updates active</strong><br>No action is required.</div>`
      : `<div class="notice"><strong>Re-authorization needed</strong><br>Reconnect Cloudflare permissions to restore managed service.</div>`;
  const installationContent = installation === null
    ? `<section class="card">
         <div class="card-header"><div><p class="eyebrow">Step 1 of 2</p><h2>Create your personal runtime</h2><p>Choose thumbnail storage before Cloudflare shows the exact installation permissions.</p></div><span class="status status--pending">Not installed</span></div>
         <form method="post" action="/install/authorize">
           <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
           <label class="choice"><input type="radio" name="storage_mode" value="kv" checked><span><strong>Workers KV</strong></span><small>Best default. No credit card is normally required within Cloudflare's free allowance.</small></label>
           <label class="choice"><input type="radio" name="storage_mode" value="r2"><span><strong>R2</strong></span><small>More thumbnail capacity, but Cloudflare requires an R2 subscription and payment profile.</small></label>
           <div class="actions"><button class="button" type="submit">Review Cloudflare permissions <span aria-hidden="true">→</span></button></div>
         </form>
       </section>`
    : `<section class="card">
         <div class="card-header">
           <div><p class="eyebrow">Personal runtime</p><h2>${isReady ? "Your library is ready" : runtimeMissing ? "Your runtime Worker was deleted" : "Installation in progress"}</h2><p>${isReady ? "Open your private Later Gator or review its managed release status." : runtimeMissing ? "Cloudflare no longer has the Worker recorded for this library. Your personal data stores were not opened or changed." : "Setup is resumable and reuses every resource already created."}</p></div>
           <span class="status ${isReady ? "" : "status--pending"}">${escapeHtml(runtimeMissing ? "Worker missing" : statusLabel(installation.status))}</span>
         </div>
         <div class="metrics">
           <div class="metric"><span class="metric-label">Storage</span><span class="metric-value">${escapeHtml(installation.storageMode.toUpperCase())}</span></div>
           <div class="metric"><span class="metric-label">Runtime</span><span class="metric-value">${escapeHtml(installation.installedRelease ?? "Pending")}</span></div>
           <div class="metric"><span class="metric-label">Updates</span><span class="metric-value">${escapeHtml(statusLabel(installation.updateStatus))}</span></div>
         </div>
         ${runtimeMissing
           ? `<div class="notice notice--warning"><strong>Runtime unavailable.</strong> The Worker was deleted outside Later Gator. The stale website link has been disabled.</div>`
           : installation.safeErrorCode === "r2_subscription_required"
           ? `<div class="notice notice--warning">R2 is not active for this Cloudflare account. Complete Cloudflare's R2 checkout, then return here to continue.</div>`
           : installation.safeErrorCode === null
             ? ""
             : `<div class="notice notice--warning">Setup paused safely (${escapeHtml(installation.safeErrorCode)}). Continue to retry only the unfinished step.</div>`}
         ${installation.authorizationActive
           ? ""
           : `<div class="notice notice--warning"><strong>Cloudflare permission required.</strong> Managed updates cannot continue until the installation is re-authorized.</div>
              <form method="post" action="/install/authorize">
                <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="storage_mode" value="${escapeHtml(installation.storageMode)}">
                <div class="actions"><button class="button" type="submit">Restore managed updates</button></div>
              </form>`}
         ${isReady
           ? `<div class="actions"><a class="button" href="/runtime/open">Open Later Gator <span aria-hidden="true">↗</span></a></div>`
           : runtimeMissing
             ? `<form method="post" action="/install/repair">
                  <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                  <div class="actions"><button class="button" type="submit">Recreate missing Worker</button></div>
                </form>`
             : `<form method="post" action="/install/provision">
                <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                <div class="actions"><button class="button" type="submit">${installation.status === "authorized" ? "Create my Later Gator" : "Continue setup"}</button></div>
              </form>`}
         ${installation.status === "ready"
           ? ""
           : `<form class="danger" method="post" action="/install/cleanup">
                <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="confirmation" value="delete-created-resources">
                <p>Cancel this incomplete setup and delete only the Cloudflare resources Later Gator created.</p>
                <button class="button button--danger" type="submit">Delete incomplete setup</button>
              </form>`}
       </section>`;
  return page(
    "Installation",
    `<header class="topbar">
       <a class="brand" href="/"><span class="brand-mark">LG</span><span>Later Gator</span></a>
       <form method="post" action="/auth/logout">
         <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
         <button class="button button--secondary" type="submit">Sign out</button>
       </form>
     </header>
     <section class="hero">
       <div><p class="eyebrow">Installation control</p><h1>Your Later Gator</h1></div>
       ${isReady ? `<div class="actions"><a class="button" href="/runtime/open">Open your library <span aria-hidden="true">↗</span></a></div>` : ""}
     </section>
     <div class="dashboard-grid">
       <div class="stack">
         ${installationContent}
         <section class="card"><p class="eyebrow">Release activity</p><h2>Update history</h2>${releaseHistory}</section>
       </div>
       <aside class="stack">
         <section class="card managed">
           <div class="managed-mark">✓</div>
           <p class="eyebrow">Managed updates</p>
           <h2>Always compatible</h2>
           <p>Runtime, UI, provider compatibility, and safe schema releases are installed automatically after health checks.</p>
           ${managedUpdateNotice}
         </section>
         <section class="card">
           <p class="eyebrow">Privacy boundary</p>
           <h2>Your content stays personal</h2>
           <p>Bookmark content, thumbnails, AI settings, and provider keys remain inside your personal Worker. The control plane stores identity and installation-management metadata only.</p>
         </section>
         <section class="card">
           <p class="eyebrow">Account</p>
           <h2>Control-plane data</h2>
           <p>Deleting this metadata does not delete your personal Cloudflare resources.</p>
           <form class="danger" method="post" action="/account/delete">
             <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
             <input type="hidden" name="confirmation" value="delete-control-metadata">
             <button class="button button--danger" type="submit">Delete account metadata</button>
           </form>
         </section>
       </aside>
     </div>`,
  );
}

/** Renders a safe error page using only an approved outcome code. */
export function renderErrorPage(outcomeCode: string): string {
  const explanation = outcomeCode === "installer_account_already_linked"
    ? "This Cloudflare account is already linked to an existing Later Gator account. Sign in with that account instead."
    : "Return to your installation dashboard and retry in a moment.";
  return page(
    "Unable to continue",
    `<div class="auth-grid">
       <section class="auth-intro">
         <div class="brand"><span class="brand-mark">LG</span><span>Later Gator</span></div>
         <p class="eyebrow" style="margin-top:3.5rem">Setup paused</p>
         <h1>Nothing unsafe was changed.</h1>
         <p>The operation stopped before Later Gator could continue.</p>
       </section>
       <section class="auth-card">
         <p class="eyebrow">Try again</p>
         <h2>We could not continue</h2>
         <p>${escapeHtml(explanation)}</p>
         <div class="notice">Reference: ${escapeHtml(outcomeCode)}</div>
         <a class="button button--wide" href="/">Return to Later Gator</a>
       </section>
     </div>`,
    "auth",
  );
}
