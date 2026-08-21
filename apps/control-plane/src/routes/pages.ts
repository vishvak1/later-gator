/** Escapes the only dynamic values inserted into server-rendered control-plane HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Wraps a control-plane view in a small script-free page. */
function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)} · Later Gator</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-rounded, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f0e8; color: #17382c; }
      main { width: min(38rem, calc(100% - 2rem)); padding: 2.25rem; border: 1px solid #c7c2b5; border-radius: 1.25rem; background: #fffdf7; box-shadow: 0 1.5rem 4rem #17382c1a; }
      h1 { margin-top: 0; font-size: clamp(2rem, 8vw, 3.4rem); letter-spacing: -.05em; }
      p { line-height: 1.6; }
      .eyebrow { color: #527564; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: .75rem; }
      .button { display: inline-block; margin-top: 1rem; border: 0; border-radius: 999px; padding: .85rem 1.15rem; background: #17382c; color: white; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
      .boundary { margin-top: 1.5rem; padding: 1rem; border-radius: .8rem; background: #e9f2eb; font-size: .92rem; }
      .danger { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid #c7c2b5; }
      .choice { display: block; margin: .8rem 0; padding: 1rem; border: 1px solid #c7c2b5; border-radius: .8rem; }
      .choice small { display: block; margin: .35rem 0 0 1.5rem; line-height: 1.45; }
      form { margin: 0; }
    </style>
  </head>
  <body><main>${content}</main></body>
</html>`;
}

/** Renders the public identity entry point without asking for deployment authority. */
export function renderSignedOutPage(): string {
  return page(
    "Sign in",
    `<p class="eyebrow">Private bookmarks, your Cloudflare</p>
     <h1>Later Gator</h1>
     <p>Sign in with Cloudflare to manage a personal Later Gator installation in your own account.</p>
     <a class="button" href="/auth/cloudflare">Continue with Cloudflare</a>
     <p class="boundary"><strong>Your data boundary:</strong> bookmark content, thumbnails, AI settings, and provider keys belong in your personal Worker—not on latergator.app.</p>`,
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
    ? ""
    : `<section class="boundary"><strong>Update history</strong><ul>${releases.map((release) =>
      `<li>${escapeHtml(release.release)} · ${escapeHtml(release.state.replaceAll("_", " "))}${
        release.safeErrorCode === null ? "" : ` · ${escapeHtml(release.safeErrorCode)}`
      }</li>`
    ).join("")}</ul></section>`;
  const installationContent = installation === null
    ? `<p>No personal installation has been provisioned yet. Choose where thumbnail images should be stored before Cloudflare asks you to approve the exact installation permissions.</p>
     <form method="post" action="/install/authorize">
       <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
       <label class="choice"><input type="radio" name="storage_mode" value="kv" checked> <strong>Workers KV</strong><small>No credit card is normally required for the current free allowance. If the allowance is reached, Later Gator can stop new thumbnails without affecting bookmarks.</small></label>
       <label class="choice"><input type="radio" name="storage_mode" value="r2"> <strong>R2</strong><small>More free thumbnail storage is currently offered, but Cloudflare requires an R2 subscription and payment profile. Later Gator never enables it silently.</small></label>
       <button class="button" type="submit">Continue to Cloudflare permissions</button>
     </form>`
    : `<p>Your ${escapeHtml(installation.storageMode.toUpperCase())} installation is <strong>${escapeHtml(installation.status.replaceAll("_", " "))}</strong>.</p>
       ${installation.safeErrorCode === "r2_subscription_required"
         ? `<p class="boundary">R2 is not active for this Cloudflare account. Complete Cloudflare's R2 checkout, then return here and continue. Later Gator will reuse every resource already created.</p>`
         : installation.safeErrorCode === null
           ? ""
           : `<p class="boundary">Setup paused safely (${escapeHtml(installation.safeErrorCode)}). Continue to retry only the unfinished step.</p>`}
       ${installation.status === "ready" && installation.workerOrigin !== null
         ? `<p><a class="button" href="${escapeHtml(installation.workerOrigin)}">Open Later Gator</a></p>
            <p>Runtime ${escapeHtml(installation.installedRelease ?? "unknown")} · update ${escapeHtml(installation.updateStatus)}</p>`
         : `<form method="post" action="/install/provision">
              <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
              <button class="button" type="submit">${installation.status === "authorized" ? "Create my Later Gator" : "Continue setup"}</button>
            </form>`}
       <p class="boundary">Provisioning is resumable. Retrying never creates a second personal installation.</p>
       <p>Managed-update authorization: <strong>${installation.authorizationActive ? "active" : "revoked"}</strong>.</p>
       ${releaseHistory}
       ${installation.status === "ready"
         ? ""
         : `<form class="danger" method="post" action="/install/cleanup">
              <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
              <input type="hidden" name="confirmation" value="delete-created-resources">
              <p>Cancel setup and delete only the Cloudflare resources created for this incomplete installation. This cannot be undone.</p>
              <button class="button" type="submit">Delete incomplete installation</button>
            </form>`}
       <form class="danger" method="post" action="/install/revoke">
         <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
         <input type="hidden" name="confirmation" value="revoke-installer-authorization">
         <p>Stop Later Gator from installing or updating this runtime. Your existing personal app and data keep working.</p>
         <button class="button" type="submit">Revoke update authorization</button>
       </form>`;
  return page(
    "Installation",
    `<p class="eyebrow">Cloudflare account connected</p>
     <h1>Your Later Gator</h1>
     ${installationContent}
     <p class="boundary">This control plane stores only identity and installation-management metadata. It does not receive normal Later Gator traffic.</p>
     <form method="post" action="/auth/logout">
       <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
       <button class="button" type="submit">Sign out</button>
     </form>
     <form class="danger" method="post" action="/account/delete">
       <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
       <input type="hidden" name="confirmation" value="delete-control-metadata">
       <p>Delete the identity and session metadata held by latergator.app. This does not delete a personal Cloudflare installation.</p>
       <button class="button" type="submit">Delete control-plane account</button>
     </form>`,
  );
}

/** Renders a safe error page using only an approved outcome code. */
export function renderErrorPage(outcomeCode: string): string {
  return page(
    "Unable to continue",
    `<p class="eyebrow">Setup paused</p>
     <h1>We could not continue</h1>
     <p>Nothing was installed or changed in your Cloudflare account. Try again in a moment.</p>
     <p class="boundary">Reference: ${escapeHtml(outcomeCode)}</p>
     <a class="button" href="/">Return to Later Gator</a>`,
  );
}
