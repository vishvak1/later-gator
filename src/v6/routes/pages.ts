import { ASSET_MANIFEST } from "../generated/asset-manifest";
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com https://api.anthropic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} satisfies HeadersInit;

const APP_ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2f7d4f"/><path d="M10 31c0-9 7-16 16-16h13c8 0 15 5 17 12l-9 1 9 4c-2 10-10 17-21 17H23C16 49 10 43 10 36v-5Z" fill="#eef6df"/><circle cx="25" cy="25" r="3" fill="#183222"/><circle cx="42" cy="25" r="3" fill="#183222"/><path d="M23 39h24M29 39l3 5 3-5 3 5 3-5" fill="none" stroke="#2f7d4f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
)}`;


export type Theme = "light" | "dark" | "system";

export function themeFromCookie(request: Request): Theme {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)lg_theme=(light|dark|system)(?:;|$)/u.exec(cookie);
  return (match?.[1] as Theme | undefined) ?? "system";
}

function page(
  title: string,
  pageName: string,
  body: string,
  status = 200,
  theme: Theme = "system",
): Response {
  return new Response(
    `<!doctype html>
<html lang="en"${theme === "system" ? "" : ` data-theme="${theme}"`}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Later Gator</title>
  <link rel="icon" href="${APP_ICON}" type="image/svg+xml">
  <link rel="stylesheet" href="${ASSET_MANIFEST.css}">
</head>
<body class="min-h-screen antialiased" data-page="${pageName}">
${body}
<script type="module" src="${ASSET_MANIFEST.js}"></script>
</body>
</html>`,
    { status, headers: PAGE_HEADERS },
  );
}

function themeControls(compact = false): string {
  return `<div class="theme-options${compact ? " compact" : ""}" role="group" aria-label="Color theme">
    <button class="theme-option" type="button" data-theme-choice="light" aria-pressed="false">Light</button>
    <button class="theme-option" type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
    <button class="theme-option" type="button" data-theme-choice="system" aria-pressed="false">System</button>
  </div>`;
}

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

function navigation(active: "dashboard" | "settings"): string {
  return `<header class="topbar">
    <a class="brand" href="/dashboard"><span>🐊</span> Later Gator</a>
    <nav aria-label="Primary">
      <a ${active === "dashboard" ? 'aria-current="page"' : ""} href="/dashboard">Library</a>
      <a ${active === "settings" ? 'aria-current="page"' : ""} href="/settings">Settings</a>
    </nav>
    <button class="ghost" id="logoutButton" type="button">Log out</button>
  </header>`;
}

export function loginPage(
  error: "invalid" | "unavailable" | null = null,
  theme: Theme = "system",
): Response {
  const errorMessage =
    error === "invalid"
      ? "That password was not accepted."
      : error === "unavailable"
        ? "Secure authentication is temporarily unavailable. Please try again after updating Later Gator."
        : null;
  return page(
    "Sign in",
    "login",
    `<main class="auth-shell">
      <section class="auth-card space-y-5">
        <div class="logo">🐊</div>
        <h1>Later Gator</h1>
        <p class="muted">Your private, AI-organized bookmark library.</p>
        ${errorMessage === null ? "" : `<p class="error" role="alert">${errorMessage}</p>`}
        <form class="stack" method="post" action="/auth/login">
          <label>Later Gator password
            <input name="password" type="password" autocomplete="current-password" required autofocus>
          </label>
          <button class="wide" type="submit">Continue</button>
        </form>
      </section>
    </main>`,
    error === "unavailable" ? 503 : 200,
    theme,
  );
}

export function setupPage(theme: Theme = "system"): Response {
  return page(
    "Setup",
    "setup",
    `<main class="setup-shell">
      <header class="setup-header"><span class="logo small">🐊</span><div class="setup-heading"><h1>Set up Later Gator</h1><p class="muted">Choose your interests and optionally import your Raindrop library.</p></div></header>
      <form id="setupForm" class="stack">
        <section class="panel topic-onboarding"><span class="step">1</span><h2>Shape your starting interests</h2>
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
        <section class="panel"><span class="step">2</span><h2>Career and aspirations</h2>
          <label>What is your career?<textarea id="careerContext" required maxlength="2000"></textarea></label>
          <label>What do you aspire to be?<textarea id="aspirationContext" required maxlength="2000"></textarea></label>
        </section>
        <section class="panel"><span class="step">3</span><h2>Personal AI instructions <small>Optional</small></h2>
          <textarea id="personalInstructions" maxlength="5000" placeholder="How should Later Gator describe, tag, and prioritize your bookmarks?"></textarea>
        </section>
        <section class="panel"><span class="step">4</span><h2>Import from Raindrop <small>Optional</small></h2>
          <p class="muted">Upload the CSV now, or skip it and import later from Settings.</p>
          <details class="import-help"><summary>How to export from Raindrop</summary><ol class="instructions"><li>Open Raindrop Settings.</li><li>Choose Backups → Export.</li><li>Select CSV, download it, then return here.</li></ol></details>
          <label class="file-field">Raindrop CSV<input id="setupImportFile" type="file" accept=".csv,text/csv"></label>
          <div class="choice-grid" role="radiogroup" aria-label="Raindrop import behavior">
            <label class="choice-card"><input type="radio" name="setupImportOption" value="reorganize" checked><span><strong>Reorganize everything</strong><small>Keep URLs and titles. AI creates descriptions, tags, and folder assignments.</small></span></label>
            <label class="choice-card"><input type="radio" name="setupImportOption" value="preserve"><span><strong>Keep tags and descriptions</strong><small>Retain imported tags and descriptions. AI assigns folders only.</small></span></label>
          </div>
          <p class="muted">In both cases, every bookmark first stays in Unsorted. Only Unsorted bookmarks are processed by AI; imported folders are never reused.</p>
        </section>
        <section class="panel"><span class="step">5</span><h2>Ready</h2>
          <p>Folders are fixed. Tags and bookmarks remain under your control.</p>
          <button id="finishSetupButton" type="submit" disabled>Finish setup and open dashboard</button>
          <p id="setupStatus" class="status" role="status"></p>
        </section>
      </form>
    </main>`,
    200,
    theme,
  );
}

export function dashboardPage(theme: Theme = "system"): Response {
  return page(
    "Dashboard",
    "dashboard",
    `${navigation("dashboard")}
    <div class="app-layout">
      <aside class="sidebar">
        <button id="addBookmarkButton" class="wide add-button">＋ Add bookmark</button>
        <p class="sidebar-label">Library</p>
        <nav id="folderNavigation" aria-label="Folders"></nav>
        <div class="sidebar-section-heading"><p class="sidebar-label">Topics</p><button id="viewAllTopicsButton" class="text-button compact" type="button">View all</button></div>
        <nav id="tagNavigation" class="tag-navigation" aria-label="Tags"></nav>
      </aside>
      <main class="library">
        <header class="library-header">
          <div><h1 id="libraryTitle">All Bookmarks</h1><p id="libraryCount" class="muted"></p></div>
        </header>
        ${importStatusPanel()}
        <section class="discovery-bar" aria-label="Search and filter bookmarks">
          <div class="search-shell">
            <span aria-hidden="true">⌕</span>
            <input id="searchInput" type="search" autocomplete="off" placeholder="Search titles, notes, descriptions… Type # for tags">
            <div id="tagSuggestions" class="suggestion-menu" hidden></div>
          </div>
          <button id="filterButton" class="secondary filter-button" type="button">Sort &amp; filter <span id="filterCount"></span></button>
          <div class="view-toggle" role="group" aria-label="View mode">
            <button id="viewGridButton" type="button" class="active" aria-label="Grid view">▦</button>
            <button id="viewListButton" type="button" aria-label="List view">☰</button>
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
    </div>
    <dialog id="filterDialog" class="filter-dialog">
      <form id="filterForm" method="dialog" class="stack">
        <div class="dialog-heading"><div><p class="eyebrow">Library controls</p><h2>Sort &amp; filter</h2></div><button value="cancel" class="icon-button" aria-label="Close">×</button></div>
        <div class="filter-grid">
          <label>Site<input id="siteInput" list="siteOptions" placeholder="e.g. github.com"><datalist id="siteOptions"></datalist></label>
          <label>Favorites<select id="favoriteFilter"><option value="">All bookmarks</option><option value="true">Favorites only</option><option value="false">Not favorites</option></select></label>
          <label>Sort by<select id="sortSelect"><option value="added_at">Date added</option><option value="modified_at">Date modified</option><option value="source_created_at">Date created</option><option value="hostname">Site</option><option value="title">Title</option></select></label>
          <label>Order<select id="directionSelect"><option value="desc">Newest / Z–A</option><option value="asc">Oldest / A–Z</option></select></label>
          <label>Date field<select id="dateField"><option value="added_at">Date added</option><option value="modified_at">Date modified</option><option value="source_created_at">Date created</option></select></label>
          <label>From<input id="dateFrom" type="date"></label>
          <label>To<input id="dateTo" type="date"></label>
        </div>
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
        <div class="dialog-heading"><div><p class="eyebrow">Bookmark editor</p><h2 id="bookmarkDialogTitle">Edit bookmark</h2></div><button value="cancel" class="icon-button" aria-label="Close">×</button></div>
        <input id="bookmarkId" type="hidden"><input id="bookmarkRevision" type="hidden">
        <input id="relatedBookmarkId" type="hidden">
        <label>URL<input id="bookmarkUrl" type="url" required></label>
        <label>Linked to <small>Optional related bookmark URL</small><input id="bookmarkLinkedUrl" type="url"></label>
        <label>Title<input id="bookmarkTitle" maxlength="1000"></label>
        <label>Description<textarea id="bookmarkDescription" maxlength="5000"></textarea></label>
        <label>Note<textarea id="bookmarkNote" maxlength="10000"></textarea></label>
        <label>Folder<select id="bookmarkFolder"></select></label>
        <fieldset class="bookmark-tag-field"><legend>Tags</legend><div id="bookmarkSelectedTags" class="selected-tags"></div><div class="bookmark-tag-autocomplete"><input id="bookmarkTagInput" placeholder="Type # to add tags" autocomplete="off" spellcheck="false" aria-controls="bookmarkTagSuggestions" aria-expanded="false"><div id="bookmarkTagSuggestions" class="suggestion-menu" role="listbox" hidden></div></div><small id="bookmarkTagHelp" class="muted">Type # to choose an existing tag or create a new one.</small></fieldset>
        <label><input id="bookmarkFavorite" type="checkbox"> Favorite</label>
        <div class="actions split"><button id="trashBookmarkButton" class="danger" type="button">Move to Trash</button><div><button value="cancel" class="secondary">Cancel</button> <button id="saveBookmarkButton" value="default">Save changes</button></div></div>
      </form>
    </dialog>`,
    200,
    theme,
  );
}

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
            <label>Model<input id="providerModel" required></label>
            <label id="providerKeyLabel">API key<input id="providerKey" type="password" autocomplete="off"></label>
            <button type="submit">Test and activate</button>
          </form><p id="providerStatus" class="status"></p>
          <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">View account-wide Workers AI usage ↗</a>
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
        <section class="panel panel-flow"><h2>Browser extension</h2>
          <p class="muted">Create one code containing everything the extension needs. Copy it once, then paste it into the toolbar popup.</p>
          <div class="connection-actions"><button id="pairExtension">Generate connection code</button><button class="secondary" type="button" data-extension-guide="chrome">Set up Chrome</button><button class="secondary" type="button" data-extension-guide="firefox">Set up Firefox</button></div>
          <div id="extensionCredentialPanel" class="connection-code-panel" hidden>
            <p class="eyebrow">One-time connection code</p>
            <pre id="extensionCredential" class="secret-output" tabindex="0"></pre>
            <div class="actions split"><p id="extensionCredentialStatus" class="status" role="status"></p><button id="copyExtensionCredential" type="button">Copy code</button></div>
          </div>
        </section>
        <section class="panel panel-flow"><h2>iOS Share Sheet Shortcut</h2><p class="muted">Generate one endpoint and token for an iPhone or iPad Shortcut.</p><div class="connection-actions"><button id="pairIos">Generate iOS connection</button><a class="button-link secondary" href="shortcuts://create-shortcut">Create in Shortcuts</a><button class="secondary" type="button" data-connection-guide="ios">Setup instructions</button></div><div id="iosCredentialPanel" class="connection-code-panel" hidden><div class="connection-secret"><p class="eyebrow">Endpoint</p><pre id="iosEndpoint" class="secret-output" tabindex="0"></pre><button id="copyIosEndpoint" type="button">Copy endpoint</button></div><div class="connection-secret"><p class="eyebrow">One-time token</p><pre id="iosToken" class="secret-output" tabindex="0"></pre><button id="copyIosToken" type="button">Copy token</button></div><p id="iosCredentialStatus" class="status" role="status"></p></div></section>
        <section class="panel panel-flow"><h2>MCP</h2><p class="muted">Generate a read-only connection URL for ChatGPT, Claude, or another MCP client.</p><div class="connection-actions"><button id="rotateMcp">Generate or rotate MCP URL</button><button class="secondary" type="button" data-connection-guide="mcp">Set up MCP client</button></div><div id="mcpCredentialPanel" class="connection-code-panel" hidden><p class="eyebrow">One-time MCP URL</p><pre id="mcpCredential" class="secret-output" tabindex="0"></pre><div class="actions split"><p id="mcpCredentialStatus" class="status" role="status"></p><button id="copyMcpCredential" type="button">Copy MCP URL</button></div></div></section>
        <section class="panel panel-flow span-two danger-zone"><p class="eyebrow">Testing tools</p><h2>Reset Later Gator</h2><p>Delete every bookmark, tag, thumbnail, import, connection, provider credential, and preference, then return this deployment to setup. Your Later Gator password is kept.</p><button id="resetApplicationButton" class="danger" type="button">Delete everything and restart setup</button></section>
      </div>
      <p id="settingsStatus" class="status"></p>
    </main>
    <dialog id="extensionGuideDialog" class="extension-guide-dialog">
      <div class="dialog-heading"><div><p class="eyebrow">Browser extension</p><h2>Set up Later Gator</h2></div><button id="closeExtensionGuide" class="icon-button" type="button" aria-label="Close">×</button></div>
      <p class="muted">The extension is installed locally and connects only to your Later Gator deployment.</p>
      <section id="chromeExtensionGuide" hidden>
        <h3>Chrome</h3>
        <ol class="setup-steps">
          <li><strong>Download Later Gator.</strong><span>Download or clone the repository containing the extension files.</span></li>
          <li><strong>Open extensions.</strong><span>Go to <code>chrome://extensions</code> and turn on Developer mode.</span></li>
          <li><strong>Load the extension.</strong><span>Choose Load unpacked and select the <code>extension/chrome</code> folder.</span></li>
          <li><strong>Connect once.</strong><span>Generate and copy the connection code above, click the Later Gator toolbar icon, paste the code, and select Connect.</span></li>
        </ol>
      </section>
      <section id="firefoxExtensionGuide" hidden>
        <h3>Firefox</h3>
        <ol class="setup-steps">
          <li><strong>Download Later Gator.</strong><span>Download or clone the repository containing the extension files.</span></li>
          <li><strong>Open debugging.</strong><span>Go to <code>about:debugging#/runtime/this-firefox</code>.</span></li>
          <li><strong>Load the extension.</strong><span>Choose Load Temporary Add-on and select <code>extension/firefox/manifest.json</code>.</span></li>
          <li><strong>Connect once.</strong><span>Generate and copy the connection code above, click the Later Gator toolbar icon, paste the code, and select Connect.</span></li>
        </ol>
        <p class="muted">Firefox temporary add-ons must be loaded again after the browser restarts.</p>
      </section>
    </dialog>
    <dialog id="connectionGuideDialog" class="extension-guide-dialog">
      <div class="dialog-heading"><div><p id="connectionGuideKicker" class="eyebrow"></p><h2 id="connectionGuideTitle"></h2></div><button id="closeConnectionGuide" class="icon-button" type="button" aria-label="Close">×</button></div>
      <section id="iosConnectionGuide" hidden>
        <p class="muted">The Shortcut receives one shared URL and saves it directly to Unsorted.</p>
        <a class="button-link" href="shortcuts://create-shortcut">Open a new Shortcut</a>
        <ol class="setup-steps">
          <li><strong>Generate the connection.</strong><span>Copy the endpoint and token separately. Keep the token private; it is shown only once.</span></li>
          <li><strong>Create the Share Sheet Shortcut.</strong><span>Open the editor above, name it Later Gator, and configure it to receive URLs from the Share Sheet.</span></li>
          <li><strong>Add Get Contents of URL.</strong><span>Use POST with a JSON body containing <code>requestId</code> as a new UUID and <code>url</code> as the Shortcut input.</span></li>
          <li><strong>Add authorization.</strong><span>Set the <code>Authorization</code> header to <code>Bearer &lt;token&gt;</code> using the copied token.</span></li>
          <li><strong>Show the result.</strong><span>Display Saved, Already saved, or Failed from the response before the Shortcut closes.</span></li>
        </ol>
      </section>
      <section id="mcpConnectionGuide" hidden>
        <p class="muted">The MCP URL grants read-only access to search and inspect your Later Gator library.</p>
        <ol class="setup-steps">
          <li><strong>Generate and copy the MCP URL.</strong><span>The secret is inside the URL and is shown only once.</span></li>
          <li><strong>Open your MCP client settings.</strong><span>Add a custom or remote MCP server in ChatGPT, Claude, or another supported client.</span></li>
          <li><strong>Paste the URL.</strong><span>Use the complete copied URL without adding separate authentication.</span></li>
          <li><strong>Test the connection.</strong><span>Ask the client to search your Later Gator bookmarks.</span></li>
          <li><strong>Rotate if exposed.</strong><span>Generating a new MCP URL immediately invalidates the previous one.</span></li>
        </ol>
      </section>
    </dialog>`,
    200,
    theme,
  );
}
