import { ASSET_MANIFEST } from "../generated/asset-manifest";
import { ICONS } from "../domain/icons";
const PAGE_CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com https://api.anthropic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": PAGE_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} satisfies HeadersInit;

/** Escapes dynamic text before inserting it into server-rendered HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The maintained Share Sheet Shortcut. Its two credential fields ship empty and
 * are filled by Shortcuts' import questions on install, so the link carries no
 * secret. Editing the Shortcut and re-sharing mints a new URL: change it here.
 */
const IOS_SHORTCUT_URL = "https://www.icloud.com/shortcuts/01e03ec749c040cfb3737da4970d8efd";

/**
 * The extension's own mark, so browser toolbar and web app agree. The
 * transparent artwork is the one that sits on app surfaces; `icon.png` keeps its
 * opaque background for the Apple touch icon, which must not be transparent.
 */
function brandMark(alt = ""): string {
  return `<img class="brand-mark" src="/img/icon-transparent.png" width="512" height="512" alt="${alt}"${
    alt === "" ? ' aria-hidden="true"' : ""
  }>`;
}


export type Theme = "light" | "dark" | "system";

/** Selects the saved light or dark theme from the request cookie. */
export function themeFromCookie(request: Request): Theme {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)lg_theme=(light|dark|system)(?:;|$)/u.exec(cookie);
  return (match?.[1] as Theme | undefined) ?? "system";
}

/** Builds the shared HTML document shell for a server-rendered page. */
function page(
  title: string,
  pageName: string,
  body: string,
  status = 200,
  theme: Theme = "system",
  formRedirectUri: string | null = null,
): Response {
  const headers = new Headers(PAGE_HEADERS);
  if (formRedirectUri !== null) {
    const callback = new URL(formRedirectUri);
    const isLoopback = callback.protocol === "http:" &&
      (callback.hostname === "127.0.0.1" || callback.hostname === "localhost" ||
        callback.hostname === "[::1]");
    const unsafeProtocol = callback.protocol === "about:" || callback.protocol === "blob:" ||
      callback.protocol === "data:" || callback.protocol === "file:" ||
      callback.protocol === "javascript:";
    if ((callback.protocol === "http:" && !isLoopback) || unsafeProtocol) {
      throw new Error("oauth_callback_origin_invalid");
    }
    const formActionSource = callback.origin === "null" ? callback.protocol : callback.origin;
    headers.set(
      "content-security-policy",
      PAGE_CSP.replace("form-action 'self'", `form-action 'self' ${formActionSource}`),
    );
  }
  return new Response(
    `<!doctype html>
<html lang="en"${theme === "system" ? "" : ` data-theme="${theme}"`}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Later Gator</title>
  <link rel="icon" href="/img/icon-transparent.png" type="image/png">
  <link rel="apple-touch-icon" href="/img/icon.png">
  <link rel="stylesheet" href="${ASSET_MANIFEST.css}">
</head>
<body class="min-h-screen antialiased" data-page="${pageName}">
${body}
<script type="module" src="${ASSET_MANIFEST.js}"></script>
</body>
</html>`,
    { status, headers },
  );
}

/**
 * The artwork is the control rather than a preview beneath one, so the panel
 * fills its space instead of stacking a picture under a row of buttons.
 */
function themeControls(): string {
  return `<div class="theme-options" role="group" aria-label="Color theme">
    <button class="theme-option" type="button" data-theme-choice="light" aria-pressed="false">
      <img src="/img/gator-day.png" alt="" loading="lazy" width="909" height="1280">
      <span>Light</span>
    </button>
    <button class="theme-option" type="button" data-theme-choice="dark" aria-pressed="false">
      <img src="/img/gator-night.png" alt="" loading="lazy" width="909" height="1280">
      <span>Dark</span>
    </button>
    <button class="theme-option theme-option-system" type="button" data-theme-choice="system" aria-pressed="false">
      <span class="theme-split" aria-hidden="true">
        <img src="/img/gator-day.png" alt="" loading="lazy">
        <img src="/img/gator-night.png" alt="" loading="lazy">
      </span>
      <span>System</span>
    </button>
  </div>`;
}

/** Renders current CSV import progress and its recovery controls. */
function importStatusPanel(): string {
  return `<section id="importProgressPanel" class="import-status-panel" aria-labelledby="importPanelTitle" hidden>
    <div class="import-status-copy">
      <p class="eyebrow">Raindrop import</p>
      <div class="import-progress-heading"><span id="importSpinner" class="spinner" aria-hidden="true" hidden></span><h2 id="importPanelTitle">Import in progress</h2></div>
      <p id="importPanelMessage" class="muted">You can browse your library while bookmarks are added.</p>
    </div>
    <div id="importProgressWrap" class="progress-track" role="progressbar" aria-label="Raindrop import progress" aria-valuemin="0" aria-valuemax="100" hidden>
      <span id="importProgressBar"></span>
    </div>
    <p id="importProgressLabel" class="progress-label" aria-live="polite"></p>
  </section>`;
}

/**
 * The drawer button only exists on the dashboard, because that is the only page
 * with a sidebar to open. On wider viewports it is hidden and the sidebar is
 * simply always there.
 */
function navigation(active: "dashboard" | "settings"): string {
  return `<header class="topbar">
    ${active === "dashboard"
      ? `<button class="icon-toggle nav-toggle" id="sidebarToggle" type="button" aria-expanded="false" aria-controls="appSidebar" aria-label="Show folders and topics" title="Folders and topics">${ICONS.menu}</button>`
      : ""}
    <a class="brand" href="/dashboard">${brandMark("Later Gator")}</a>
    <nav aria-label="Primary">
      <a ${active === "dashboard" ? 'aria-current="page"' : ""} href="/dashboard">Library</a>
      <a ${active === "settings" ? 'aria-current="page"' : ""} href="/settings">Settings</a>
    </nav>
    <button class="icon-toggle" id="howToButton" type="button" aria-label="How to set up Later Gator" title="How to set up Later Gator">${ICONS.help}</button>
    <button class="ghost topbar-logout" id="logoutButton" type="button"><span class="topbar-logout-icon" aria-hidden="true">${ICONS.logout}</span><span class="topbar-logout-label">Log out</span></button>
  </header>`;
}

/** Renders the reusable onboarding guidance dialog for application pages. */
function howToDialog(): string {
  return `<dialog id="howToDialog" class="how-to-dialog">
    <div class="dialog-heading">
      <div><p id="howToKicker" class="eyebrow"></p><h2 id="howToTitle"></h2></div>
      <button id="closeHowTo" class="icon-button" type="button" aria-label="Close">×</button>
    </div>
    <div id="howToBody" class="how-to-body"></div>
    <nav class="wizard-nav how-to-nav" aria-label="Guide navigation">
      <button id="howToPrev" class="secondary" type="button">← Back</button>
      <p id="howToProgress" class="status" aria-live="polite"></p>
      <button id="howToNext" type="button">Next →</button>
    </nav>
  </dialog>`;
}

/** Renders the Cloudflare-only owner sign-in entry point. */
export function loginPage(
  error: "unavailable" | null = null,
  theme: Theme = "system",
): Response {
  const errorMessage =
    error === "unavailable"
      ? "Cloudflare sign-in could not be completed. Please try again."
      : null;
  return page(
    "Sign in",
    "login",
    `<main class="auth-shell">
      <section class="auth-card space-y-5">
        <div class="logo">${brandMark()}</div>
        <h1>Later Gator</h1>
        <p class="muted">Your private, AI-organized bookmark library.</p>
        ${errorMessage === null ? "" : `<p class="error" role="alert">${errorMessage}</p>`}
        <a class="button-link wide" href="/auth/login">Continue with Cloudflare</a>
        <p class="muted">Later Gator does not use a separate password or recovery phrase.</p>
      </section>
    </main>`,
    error === "unavailable" ? 503 : 200,
    theme,
  );
}

interface OAuthConsentPageOptions {
  clientName: string;
  redirectUri: string;
  serializedRequest: string;
  csrfToken: string | null;
  error: string | null;
  theme: Theme;
}

/** Renders the plain-language owner approval screen for an AI connection. */
export function oauthConsentPage(options: OAuthConsentPageOptions): Response {
  const clientName = escapeHtml(options.clientName);
  const request = escapeHtml(options.serializedRequest);
  const csrf = options.csrfToken === null
    ? ""
    : `<input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}">`;
  return page(
    `Connect ${options.clientName}`,
    "oauth-consent",
    `<main class="auth-shell">
      <section class="auth-card oauth-consent-card space-y-5">
        <div class="logo">${brandMark()}</div>
        <p class="eyebrow">AI connection</p>
        <h1>Connect ${clientName} to Later Gator?</h1>
        <p class="muted">This gives ${clientName} read-only access to your private bookmark library.</p>
        <div class="oauth-permissions">
          <div><strong>Allowed</strong><ul><li>Search your library</li><li>Read bookmark details and library status</li></ul></div>
          <div><strong>Not allowed</strong><ul><li>Add, edit, or delete bookmarks</li><li>Change settings or access credentials</li></ul></div>
        </div>
        ${options.error === null ? "" : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`}
        <form class="stack" method="post" action="/authorize">
          <input type="hidden" name="oauth_request" value="${request}">
          ${csrf}
          <p class="connection-ready">Signed in as the Later Gator owner.</p>
          <div class="actions split"><button class="secondary" type="submit" name="decision" value="deny">Cancel</button><button type="submit" name="decision" value="approve">Connect ${clientName}</button></div>
        </form>
      </section>
    </main>`,
    200,
    options.theme,
    options.redirectUri,
  );
}

/** Renders a safe local OAuth error without redirecting to an unverified client. */
export function oauthErrorPage(message: string): Response {
  return page(
    "Connection problem",
    "oauth-error",
    `<main class="auth-shell"><section class="auth-card space-y-5"><div class="logo">${brandMark()}</div><h1>Could not connect this AI assistant</h1><p class="error" role="alert">${escapeHtml(message)}</p><p><a class="button-link secondary" href="/settings">Back to Settings</a></p></section></main>`,
    400,
  );
}

/** Sets up page for server-rendered pages. */
export function setupPage(theme: Theme = "system"): Response {
  return page(
    "Setup",
    "setup",
    `<main class="setup-shell">
      <header class="setup-header"><span class="logo small">${brandMark()}</span><div class="setup-heading"><h1>Set up Later Gator</h1><p class="muted">Choose your interests and optionally import your Raindrop library.</p></div></header>
      <ol class="wizard-progress" aria-label="Setup progress">
        <li data-step-marker="1" aria-current="step"><span>1</span>Topics</li>
        <li data-step-marker="2"><span>2</span>Personalization</li>
        <li data-step-marker="3"><span>3</span>Import</li>
      </ol>
      <form id="setupForm" class="stack">
        <section class="panel topic-onboarding wizard-screen" data-step="1"><h2>Shape your starting interests</h2>
          <p class="muted">Choose at least five topics or subtopics. These guide the first few recommendations; AI can create completely new tags whenever your bookmarks introduce new subjects.</p>
          <div id="topicPicker" class="topic-picker">
            <fieldset><legend>Technology</legend><div class="topic-options">
              <button type="button" class="topic-chip" data-topic="artificial-intelligence">artificial-intelligence</button>
              <button type="button" class="topic-chip" data-topic="software-engineering">software-engineering</button>
              <button type="button" class="topic-chip" data-topic="data-science">data-science</button>
              <button type="button" class="topic-chip" data-topic="cybersecurity">cybersecurity</button>
              <button type="button" class="topic-chip" data-topic="web-development">web-development</button>
            </div></fieldset>
            <fieldset><legend>Work &amp; Business</legend><div class="topic-options">
              <button type="button" class="topic-chip" data-topic="career">career</button>
              <button type="button" class="topic-chip" data-topic="entrepreneurship">entrepreneurship</button>
              <button type="button" class="topic-chip" data-topic="product-management">product-management</button>
              <button type="button" class="topic-chip" data-topic="finance">finance</button>
              <button type="button" class="topic-chip" data-topic="leadership">leadership</button>
            </div></fieldset>
            <fieldset><legend>Ideas &amp; Learning</legend><div class="topic-options">
              <button type="button" class="topic-chip" data-topic="research">research</button>
              <button type="button" class="topic-chip" data-topic="history">history</button>
              <button type="button" class="topic-chip" data-topic="religion-and-philosophy">religion-and-philosophy</button>
              <button type="button" class="topic-chip" data-topic="psychology">psychology</button>
              <button type="button" class="topic-chip" data-topic="education">education</button>
            </div></fieldset>
            <fieldset><legend>Creative &amp; Life</legend><div class="topic-options">
              <button type="button" class="topic-chip" data-topic="design">design</button>
              <button type="button" class="topic-chip" data-topic="writing">writing</button>
              <button type="button" class="topic-chip" data-topic="health">health</button>
              <button type="button" class="topic-chip" data-topic="travel">travel</button>
              <button type="button" class="topic-chip" data-topic="personal-growth">personal-growth</button>
            </div></fieldset>
          </div>
          <div class="custom-topic"><input id="customTopic" maxlength="512" placeholder="Add comma-separated topics"><button id="addCustomTopic" class="secondary" type="button">Add topics</button></div>
          <div id="customTopicTokens" class="topic-options custom-topic-tokens" aria-live="polite"></div>
          <p id="topicSelectionCount" class="selection-count">0 selected · choose at least 5</p>
        </section>
        <section class="panel wizard-screen" data-step="2" hidden><h2>Personalization <small>Optional</small></h2>
          <p class="muted">Tell Later Gator anything that should shape how it describes, tags, and prioritizes what you save. Your work, what you are learning, phrasing you prefer — all optional, and changeable later in Settings.</p>
          <textarea id="personalInstructions" maxlength="5000" placeholder="For example: I work on distributed systems and am learning about model quantization. Prefer precise technical tags over broad ones."></textarea>
        </section>
        <section class="panel wizard-screen" data-step="3" hidden><h2>Import from Raindrop <small>Optional</small></h2>
          <p class="muted">Upload the CSV now, or skip it and import later from Settings.</p>
          <figure class="guide-figure">
            <img src="/img/raindrop-export.png" alt="Raindrop toolbar with the Export menu open, showing HTML, CSV, TXT and ZIP options" loading="lazy" width="840" height="393">
            <figcaption>In Raindrop, open <strong>Export</strong> and choose <strong>CSV</strong>.</figcaption>
          </figure>
          <label class="file-field">Raindrop CSV<input id="setupImportFile" type="file" accept=".csv,text/csv"></label>
          <div class="choice-grid" role="radiogroup" aria-label="Raindrop import behavior">
            <label class="choice-card"><input type="radio" name="setupImportOption" value="reorganize" checked><span><strong>Reorganize everything</strong><small>Keep URLs and titles. AI creates descriptions, tags, and folder assignments.</small></span></label>
            <label class="choice-card"><input type="radio" name="setupImportOption" value="preserve"><span><strong>Keep tags and descriptions</strong><small>Retain imported tags and descriptions. AI assigns folders only.</small></span></label>
          </div>
          <p class="muted">In both cases, every bookmark first stays in Unsorted. Only Unsorted bookmarks are processed by AI; imported folders are never reused.</p>
        </section>
        <nav class="wizard-nav" aria-label="Setup navigation">
          <button id="wizardBack" class="secondary" type="button" hidden>← Back</button>
          <p id="setupStatus" class="status" role="status"></p>
          <button id="wizardNext" type="button" disabled>Next →</button>
          <button id="finishSetupButton" type="submit" hidden>Finish setup and open dashboard</button>
        </nav>
      </form>
    </main>`,
    200,
    theme,
  );
}

/** Renders the authenticated library shell populated by the browser bundle. */
export function dashboardPage(theme: Theme = "system"): Response {
  return page(
    "Dashboard",
    "dashboard",
    `${navigation("dashboard")}
    <div class="app-layout">
      <div id="sidebarScrim" class="sidebar-scrim" hidden></div>
      <aside class="sidebar" id="appSidebar">
        <button id="addBookmarkButton" class="wide add-button">＋ Add bookmark</button>
        <p class="sidebar-label">Library</p>
        <nav id="folderNavigation" aria-label="Folders"></nav>
        <div class="sidebar-section-heading"><p class="sidebar-label">Topics</p><button id="viewAllTopicsButton" class="text-button compact" type="button">View all</button></div>
        <nav id="tagNavigation" class="tag-navigation" aria-label="Tags"></nav>
      </aside>
      <main class="library">
        <header class="library-header">
          <div class="library-heading"><h1 id="libraryTitle">All Bookmarks</h1><span id="unsortedMascot" class="unsorted-mascot" aria-hidden="true" hidden>${ICONS.mascot}</span><span class="ai-alert-wrap" hidden id="aiAlertWrap"><button id="aiAlert" class="ai-alert" type="button" aria-describedby="aiAlertPopover">${ICONS.review}</button><span id="aiAlertPopover" class="ai-alert-popover" role="tooltip"></span></span><p id="libraryCount" class="muted"></p></div>
        </header>
        ${importStatusPanel()}
        <section class="discovery-bar" aria-label="Search and filter bookmarks">
          <div class="search-shell">
            <span aria-hidden="true">⌕</span>
            <input id="searchInput" type="search" autocomplete="off" placeholder="Search titles, notes, descriptions… Type # for tags">
            <div id="tagSuggestions" class="suggestion-menu" hidden></div>
          </div>
          <div class="discovery-controls">
            <button id="favoritesToggle" class="icon-toggle" type="button" aria-pressed="false" title="Show favorites in this folder" aria-label="Show favorites in this folder">${ICONS.heart}</button>
            <button id="notesToggle" class="icon-toggle" type="button" aria-pressed="false" title="Show bookmarks with your notes" aria-label="Show bookmarks with your notes">${ICONS.note}</button>
            <button id="filterButton" class="secondary filter-button" type="button">Sort &amp; filter <span id="filterCount"></span></button>
            <div class="view-toggle" role="group" aria-label="View mode">
              <button id="viewGridButton" type="button" class="active" aria-label="Grid view">▦</button>
              <button id="viewListButton" type="button" aria-label="List view">☰</button>
            </div>
          </div>
        </section>
        <div id="searchTagChips" class="selected-tags"></div>
        <p id="libraryStatus" class="status" role="status"></p>
        <section id="bookmarkGrid" class="bookmark-grid"></section>
        <div class="load-more-wrap"><button id="loadMoreBookmarks" class="secondary" type="button" hidden>Load more bookmarks</button></div>
      </main>
      <div id="bulkBar" class="bulk-bar" role="region" aria-label="Bulk actions" hidden>
        <span id="bulkCount" class="bulk-count" aria-live="polite">0 selected</span>
        <button id="bulkSelectAll" class="secondary" type="button">Select all</button>
        <label class="visually-hidden" for="bulkFolder">Move selected bookmarks to folder</label>
        <select id="bulkFolder" aria-label="Move to folder"></select>
        <button id="bulkFavorite" class="secondary" type="button">★ Favorite</button>
        <button id="bulkTrash" class="danger" type="button">Move to Trash</button>
        <button id="bulkRestore" class="secondary" type="button" hidden>Restore</button>
        <button id="bulkDelete" class="danger" type="button" hidden>Delete forever</button>
        <button id="bulkCancel" class="ghost" type="button">Cancel</button>
      </div>
      <div id="toast" class="toast" role="status" hidden>
        <span id="toastMessage"></span>
        <button id="toastUndo" type="button">Undo</button>
      </div>
      <div id="aiNotice" class="ai-notice" role="status" hidden>
        <span class="ai-notice-icon" aria-hidden="true">${ICONS.review}</span>
        <div class="ai-notice-body">
          <p id="aiNoticeMessage"></p>
          <label class="ai-notice-mute"><input id="aiNoticeMute" type="checkbox"> Don't show this again</label>
        </div>
        <button id="aiNoticeClose" class="icon-button" type="button" aria-label="Dismiss">×</button>
      </div>
    </div>
    <dialog id="filterDialog" class="filter-dialog">
      <form id="filterForm" method="dialog" class="stack">
        <div class="dialog-heading"><div><p class="eyebrow">Library controls</p><h2>Sort &amp; filter</h2></div><button value="cancel" class="icon-button" aria-label="Close">×</button></div>
        <div class="filter-grid">
          <label>Site<input id="siteInput" list="siteOptions" placeholder="e.g. github.com"><datalist id="siteOptions"></datalist></label>
          <label>Favorites<select id="favoriteFilter"><option value="">All bookmarks</option><option value="true">Favorites only</option><option value="false">Not favorites</option></select></label>
          <label>Sort by<select id="sortSelect"><option value="added_at">Date added</option><option value="modified_at">Date modified</option><option value="source_created_at">Date created</option><option value="hostname">Site</option><option value="title">Title</option></select></label>
          <label>Order<select id="directionSelect"><option value="desc">Newest / Z–A</option><option value="asc">Oldest / A–Z</option></select></label>
        </div>
        <fieldset class="date-filter span-two">
          <legend>Date range</legend>
          <div class="date-filter-grid">
            <label class="date-filter-field">Field<select id="dateField"><option value="added_at">Date added</option><option value="modified_at">Date modified</option><option value="source_created_at">Date created</option></select></label>
            <label class="date-filter-field">From<input id="dateFrom" type="date"></label>
            <span class="date-filter-arrow" aria-hidden="true">→</span>
            <label class="date-filter-field">To<input id="dateTo" type="date"></label>
          </div>
          <p id="dateFilterHelp" class="muted date-filter-help">Leave either end open for "any time before" or "any time after".</p>
        </fieldset>
        <div class="actions split"><button id="clearFilters" class="text-button" type="button">Clear filters</button><div><button value="cancel" class="secondary">Cancel</button> <button id="applyFilters" value="default">Apply filters</button></div></div>
      </form>
    </dialog>
    <dialog id="topicsDialog" class="topics-dialog">
      <div class="dialog-heading"><div><p class="eyebrow">Your topic vocabulary</p><h2>All topics</h2></div><button id="closeTopicsDialog" class="icon-button" type="button" aria-label="Close">×</button></div>
      <p class="muted">Choose a topic to filter the library. Tick topics to remove them; the bookmarks themselves are kept.</p>
      <nav id="allTagNavigation" class="all-tag-navigation" aria-label="All topics"></nav>
      <div id="topicBulkBar" class="topic-bulk-bar" hidden>
        <span id="topicBulkCount" class="bulk-count" aria-live="polite">0 topics selected</span>
        <button id="topicClearSelection" class="ghost" type="button">Clear</button>
        <button id="topicDeleteSelected" class="danger" type="button">Remove from library</button>
      </div>
    </dialog>
    <dialog id="bookmarkDialog">
      <div id="bookmarkDetailView">
        <div class="dialog-heading"><div><p id="detailFolder" class="eyebrow"></p><h2 id="detailTitle"></h2></div><button id="closeBookmarkDialog" class="icon-button" type="button" aria-label="Close">×</button></div>
        <div id="detailPreview" class="detail-preview"></div>
        <p id="detailDescription" class="detail-description"></p>
        <div id="detailReviewReason" class="review-reason" hidden></div>
        <section class="metadata-grid">
          <div><span>Note</span><p id="detailNote"></p></div>
          <div><span>Tags</span><div id="detailTags" class="chips"></div></div>
          <div><span>Site</span><p id="detailSite"></p></div>
          <div><span>Added</span><p id="detailAdded"></p></div>
          <div><span>Created</span><p id="detailCreated"></p></div>
          <div><span>Modified</span><p id="detailModified"></p></div>
          <div class="span-two"><span>Linked bookmarks</span><div id="detailRelationships"></div></div>
        </section>
        <div class="actions split"><a id="detailExternalLink" class="button-link secondary" target="_blank" rel="noreferrer">Open original ↗</a><div><button id="restoreDetailButton" class="secondary" type="button" hidden>Restore</button> <button id="deleteDetailButton" class="danger" type="button" hidden>Delete forever</button> <button id="editDetailButton" type="button">Edit bookmark</button></div></div>
      </div>
      <form id="bookmarkForm" method="dialog" class="stack" hidden>
        <div class="dialog-heading"><div><p class="eyebrow">Bookmark editor</p><h2 id="bookmarkDialogTitle">Edit bookmark</h2></div><button value="cancel" class="icon-button" formnovalidate aria-label="Close">×</button></div>
        <input id="bookmarkId" type="hidden"><input id="bookmarkRevision" type="hidden">
        <input id="relatedBookmarkId" type="hidden">
        <label>URL<input id="bookmarkUrl" type="url" required></label>
        <fieldset class="bookmark-link-field"><legend>Linked to <small>Optional related bookmark</small></legend>
          <input id="bookmarkLinkedUrl" type="hidden">
          <div id="bookmarkLinkedSelected" class="selected-link" hidden><span id="bookmarkLinkedLabel"></span><button id="bookmarkLinkedClear" class="chip-remove" type="button" aria-label="Remove linked bookmark">×</button></div>
          <div class="bookmark-link-autocomplete"><input id="bookmarkLinkedSearch" type="search" placeholder="Search your bookmarks…" autocomplete="off" aria-controls="bookmarkLinkedSuggestions" aria-expanded="false"><div id="bookmarkLinkedSuggestions" class="suggestion-menu" role="listbox" hidden></div></div>
          <small id="bookmarkLinkedHelp" class="muted">Type at least 2 characters to search your bookmarks.</small>
        </fieldset>
        <label>Title<input id="bookmarkTitle" maxlength="1000"></label>
        <label>Description<textarea id="bookmarkDescription" maxlength="5000"></textarea></label>
        <label>Note<textarea id="bookmarkNote" maxlength="10000"></textarea></label>
        <label>Folder<select id="bookmarkFolder"></select></label>
        <fieldset class="bookmark-tag-field"><legend>Tags</legend><div id="bookmarkSelectedTags" class="selected-tags"></div><div class="bookmark-tag-autocomplete"><input id="bookmarkTagInput" placeholder="Type # to add tags" autocomplete="off" spellcheck="false" aria-controls="bookmarkTagSuggestions" aria-expanded="false"><div id="bookmarkTagSuggestions" class="suggestion-menu" role="listbox" hidden></div></div><small id="bookmarkTagHelp" class="muted">Type # to choose an existing tag or create a new one.</small></fieldset>
        <label><input id="bookmarkFavorite" type="checkbox"> Favorite</label>
        <div class="actions split"><button id="trashBookmarkButton" class="danger" type="button">Move to Trash</button><div><button value="cancel" class="secondary" formnovalidate>Cancel</button> <button id="saveBookmarkButton" value="default">Save changes</button></div></div>
      </form>
    </dialog>
    <dialog id="xDestinationReviewDialog" class="x-review-dialog">
      <div class="dialog-heading"><div><p class="eyebrow">X post review</p><h2>Destination already saved</h2></div><button id="closeXDestinationReview" class="icon-button" type="button" aria-label="Close">×</button></div>
      <p class="muted">Choose which links this post should connect to. Existing X posts using the same saved destination are shown below.</p>
      <div id="xDestinationReviewItems" class="x-review-items"></div>
      <p id="xDestinationReviewStatus" class="status" role="status"></p>
      <div class="actions split"><button id="removeReviewedXPost" class="danger" type="button">Move post to Trash</button><div><button id="cancelXDestinationReview" class="secondary" type="button">Cancel</button> <button id="keepReviewedXPost" type="button">Keep post</button></div></div>
    </dialog>
    ${howToDialog()}`,
    200,
    theme,
  );
}

/** Sets tings page for server-rendered pages. */
export function settingsPage(theme: Theme = "system"): Response {
  return page(
    "Settings",
    "settings",
    `${navigation("settings")}
    <main class="settings-shell">
      <header><h1>Settings</h1><p class="muted">Connections, automation, imports, and security.</p></header>
      <div class="settings-grid">
        <section class="panel panel-flow"><h2>Appearance</h2>
          <p class="muted">Choose how Later Gator looks. System follows your device setting.</p>
          ${themeControls()}
        </section>
        <section class="panel panel-flow"><h2>AI provider</h2>
          <form id="providerForm" class="stack">
            <label>Provider<select id="providerName"><option value="workers-ai">Cloudflare Workers AI</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
            <label>Model<select id="providerModel" required><option value="">Loading supported models…</option></select></label>
            <label id="providerKeyLabel">API key<input id="providerKey" type="password" autocomplete="off"></label>
            <div class="control-row"><button type="submit">Test and activate</button><button id="openAdvancedProvider" class="icon-toggle" type="button" aria-label="Advanced provider settings" title="Advanced">${ICONS.settings}</button></div>
          </form><p id="providerStatus" class="status"></p>
          <div class="connection-actions"><button class="secondary" type="button" data-how-to="models">How to change the model</button><a class="button-link secondary" href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">Workers AI usage ↗</a></div>
        </section>
        <section class="panel panel-flow"><h2>AI sorting</h2>
          <p id="automationStatus"></p>
          <div id="automationProgress" class="automation-progress">
            <div class="progress-track"><span id="automationProgressBar"></span></div>
            <p id="automationProgressLabel" class="progress-label"></p>
            <div id="automationProgressStates" class="progress-states"></div>
          </div>
          <p class="muted">Setup topics are only a starting point. While AI is running it may create new, precise tags for subjects it discovers.</p>
          <button id="automationButton" class="secondary">Pause AI</button>
        </section>
        <section class="panel panel-flow"><h2>Personal AI instructions</h2>
          <p class="muted">These instructions guide future AI processing and can be changed at any time.</p>
          <form id="personalInstructionsForm" class="stack">
            <textarea id="settingsPersonalInstructions" maxlength="5000" placeholder="How should Later Gator describe, tag, and prioritize your bookmarks?"></textarea>
            <button type="submit">Save instructions</button>
          </form>
          <p id="personalInstructionsStatus" class="status" role="status"></p>
        </section>
        <section class="panel panel-flow"><h2>Raindrop CSV import</h2>
          <form id="importForm" class="stack"><input id="importFile" type="file" accept=".csv,text/csv" required>
            <select id="importOption" aria-label="Import behavior"><option value="reorganize">Reorganize everything — replace tags and descriptions</option><option value="preserve">Keep imported tags and descriptions — assign folders only</option></select>
            <button type="submit">Import bookmarks</button>
          </form>
          ${importStatusPanel()}
          <p class="muted">Folder-only and full-library exports are supported. Both modes start in Unsorted, and only Unsorted bookmarks are processed by AI.</p><p id="importStatus" class="status"></p>
        </section>
        <section class="panel panel-flow"><h2>Export</h2><p>Download a portable copy of the Later Gator library.</p><div class="control-row"><a class="button-link" href="/api/export?format=json">Export JSON</a><a class="button-link secondary" href="/api/export?format=csv">Export CSV</a></div></section>
        <section class="panel panel-flow"><h2>Thumbnail storage</h2>
          <p id="thumbnailStorageSummary" class="muted">Loading personal storage status…</p>
          <p id="thumbnailStorageMigration" class="muted" hidden></p>
          <div id="storagePlanFacts" class="stack"><p class="muted">Loading current Cloudflare plan information…</p></div>
          <div class="connection-actions">
            <button id="disableThumbnailStorage" class="secondary" type="button">Stop future thumbnails</button>
            <button id="enableKvThumbnailStorage" class="secondary" type="button" hidden>Use KV again</button>
            <button id="reclaimThumbnailStorage" class="secondary" type="button">Remove 100 oldest</button>
            <button id="migrateThumbnailStorage" type="button">Move thumbnails to R2</button>
            <button id="approveThumbnailCleanup" class="danger" type="button" hidden>Approve KV cleanup</button>
          </div>
          <p class="muted">Bookmarks and AI continue if thumbnail storage is disabled or unavailable. Moving to R2 copies and verifies every object first; KV is deleted only after your separate approval.</p>
          <p id="thumbnailStorageStatus" class="status" role="status"></p>
        </section>
        <section class="panel panel-flow"><h2>Browser extension</h2>
          <p class="muted">Install the official Chrome extension, then choose Continue with Cloudflare in its popup. It discovers this personal installation and asks Chrome for access only to this Worker.</p>
          <div class="connection-actions"><button class="secondary" type="button" data-how-to="chrome">Set up Chrome</button></div>
          <div id="extensionDevices" class="ai-connection-list" aria-live="polite"><p class="muted">Loading connected Chrome devices…</p></div>
          <p id="extensionDeviceStatus" class="status" role="status"></p>
        </section>
        <section class="panel panel-flow"><h2>iOS Share Sheet Shortcut</h2><p class="muted">Generate one endpoint and token for an iPhone or iPad Shortcut.</p><div class="connection-actions"><button id="pairIos">Generate iOS connection</button><a class="button-link" href="${IOS_SHORTCUT_URL}" target="_blank" rel="noreferrer">Add to Shortcuts ↗</a><button class="secondary" type="button" data-how-to="ios">Setup instructions</button></div><div id="iosCredentialPanel" class="connection-code-panel" hidden><div class="connection-secret"><p class="eyebrow">Endpoint</p><pre id="iosEndpoint" class="secret-output" tabindex="0"></pre><button id="copyIosEndpoint" type="button">Copy endpoint</button></div><div class="connection-secret"><p class="eyebrow">One-time token</p><pre id="iosToken" class="secret-output" tabindex="0"></pre><button id="copyIosToken" type="button">Copy token</button></div><p id="iosCredentialStatus" class="status" role="status"></p></div></section>
        <section class="panel panel-flow span-two"><div><p class="eyebrow">MCP</p><h2>Connect Codex or Claude Code</h2></div><p class="muted">Copy one command into your terminal. It installs Later Gator, opens your browser for Cloudflare sign-in when needed, and asks you to approve read-only access. No developer mode or secret token is required.</p><div class="connection-code-panel mcp-command-panel"><div class="connection-secret"><p class="eyebrow">Codex</p><pre id="codexMcpCommand" class="secret-output" tabindex="0"></pre><button id="copyCodexMcpCommand" type="button">Copy Codex command</button></div><div class="connection-secret"><p class="eyebrow">Claude Code</p><pre id="claudeMcpCommand" class="secret-output" tabindex="0"></pre><button id="copyClaudeMcpCommand" type="button">Copy Claude command</button></div></div><div class="connection-actions"><button class="secondary" type="button" data-how-to="mcp">Setup help</button></div><p id="mcpConnectionStatus" class="status" role="status"></p><div id="mcpConnections" class="ai-connection-list" aria-live="polite"><p class="muted">Loading connected assistants…</p></div><details class="advanced-connection"><summary>Advanced connection details</summary><p class="muted">Use this address with any OAuth-capable remote MCP client.</p><div class="endpoint-row"><code id="mcpEndpoint"></code><button id="copyMcpEndpoint" class="secondary" type="button">Copy address</button></div></details></section>
        <section class="panel panel-flow span-two danger-zone"><p class="eyebrow">Testing tools</p><h2>Reset Later Gator</h2><p>Delete every bookmark, tag, thumbnail, import, connection, provider credential, and preference, then return this installation to setup. Your Cloudflare owner binding is kept.</p><button id="resetApplicationButton" class="danger" type="button">Delete everything and restart setup</button></section>
      </div>
      <p id="settingsStatus" class="status"></p>
    </main>
    ${howToDialog()}
    <dialog id="advancedProviderDialog" class="advanced-dialog">
      <div class="dialog-heading"><div><p class="eyebrow">AI provider</p><h2>Advanced</h2></div><button id="closeAdvancedProvider" class="icon-button" type="button" aria-label="Close">×</button></div>
      <label>AI Gateway ID <small>Optional</small>
        <input id="aiGatewayId" maxlength="64" placeholder="later-gator-ai-gateway" autocomplete="off" spellcheck="false">
      </label>
      <p class="muted">Leave empty to call Workers AI directly on the free daily allocation. Set it to route organizing and search embeddings through your gateway, which is the only way prepaid credits are spent.</p>
      <div class="actions split"><button class="secondary" type="button" data-how-to="models">How to set this up</button><button id="saveAdvancedProvider" type="button">Save</button></div>
      <p id="advancedProviderStatus" class="status" role="status"></p>
    </dialog>
    `,
    200,
    theme,
  );
}
