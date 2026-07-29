const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com https://api.anthropic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} satisfies HeadersInit;

function page(title: string, pageName: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Later Gator</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body data-page="${pageName}">
${body}
<script src="/app.js" defer></script>
</body>
</html>`,
    { status, headers: PAGE_HEADERS },
  );
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
      <section class="auth-card">
        <div class="logo">🐊</div>
        <h1>Later Gator</h1>
        <p class="muted">Your private, AI-organized bookmark library.</p>
        ${errorMessage === null ? "" : `<p class="error" role="alert">${errorMessage}</p>`}
        <form method="post" action="/auth/login">
          <label>Later Gator password
            <input name="password" type="password" autocomplete="current-password" required autofocus>
          </label>
          <button type="submit">Continue</button>
        </form>
      </section>
    </main>`,
    error === "unavailable" ? 503 : 200,
  );
}

export function setupPage(): Response {
  return page(
    "Setup",
    "setup",
    `<main class="setup-shell">
      <header class="setup-header"><span class="logo small">🐊</span><div><h1>Set up Later Gator</h1><p class="muted">Required profile first; import and MCP are optional.</p></div></header>
      <form id="setupForm" class="stack">
        <section class="panel"><span class="step">1</span><h2>Your most relevant topics</h2>
          <p>Enter 5–20 comma-separated tags.</p>
          <input id="setupTags" required placeholder="ai, software engineering, research, design, systems">
        </section>
        <section class="panel"><span class="step">2</span><h2>Career and aspirations</h2>
          <label>What is your career?<textarea id="careerContext" required maxlength="2000"></textarea></label>
          <label>What do you aspire to be?<textarea id="aspirationContext" required maxlength="2000"></textarea></label>
        </section>
        <section class="panel"><span class="step">3</span><h2>Personal AI instructions <small>Optional</small></h2>
          <textarea id="personalInstructions" maxlength="5000" placeholder="How should Later Gator describe, tag, and prioritize your bookmarks?"></textarea>
        </section>
        <section class="panel"><span class="step">4</span><h2>Import from Raindrop <small>Optional</small></h2>
          <ol class="instructions"><li>Open Raindrop Settings.</li><li>Choose Backups → Export.</li><li>Select CSV and download it.</li></ol>
          <div class="screenshot-placeholder">Raindrop export screenshot placeholder 1</div>
          <div class="screenshot-placeholder">Raindrop export screenshot placeholder 2</div>
          <input id="setupImportFile" type="file" accept=".csv,text/csv">
          <label><input type="radio" name="setupImportOption" value="reorganize" checked> Strip imported tags/description and reorganize from Unsorted</label>
          <label><input type="radio" name="setupImportOption" value="preserve"> Preserve tags/description and classify through Imports</label>
        </section>
        <section class="panel"><span class="step">5</span><h2>MCP connection <small>Optional</small></h2>
          <p>Connect ChatGPT or Claude later from Settings, or generate your private read-only URL now.</p>
          <label><input id="setupMcp" type="checkbox"> Generate my MCP connection after setup</label>
        </section>
        <section class="panel"><span class="step">6</span><h2>Ready</h2>
          <p>Folders are fixed. Tags and bookmarks remain under your control.</p>
          <button type="submit">Finish setup</button>
          <p id="setupStatus" class="status" role="status"></p>
        </section>
      </form>
    </main>`,
  );
}

export function dashboardPage(): Response {
  return page(
    "Dashboard",
    "dashboard",
    `${navigation("dashboard")}
    <div class="app-layout">
      <aside class="sidebar">
        <button id="addBookmarkButton" class="wide">＋ Add bookmark</button>
        <nav id="folderNavigation" aria-label="Folders"></nav>
      </aside>
      <main class="library">
        <header class="library-header">
          <div><h1 id="libraryTitle">All Bookmarks</h1><p id="libraryCount" class="muted"></p></div>
          <button id="editModeButton" class="secondary" type="button">Enter edit mode</button>
        </header>
        <section class="filters" aria-label="Bookmark filters">
          <input id="searchInput" type="search" placeholder="Search bookmarks">
          <input id="siteInput" placeholder="Filter by site">
          <select id="tagFilter"><option value="">All tags</option></select>
          <select id="favoriteFilter"><option value="">All bookmarks</option><option value="true">Favorites</option><option value="false">Not favorites</option></select>
          <select id="sortSelect"><option value="modified_at">Date modified</option><option value="added_at">Date added</option><option value="source_created_at">Date created</option><option value="hostname">Site</option><option value="title">Title</option></select>
          <select id="directionSelect"><option value="desc">Descending</option><option value="asc">Ascending</option></select>
          <select id="dateField"><option value="added_at">Date added</option><option value="modified_at">Date modified</option><option value="source_created_at">Date created</option></select>
          <input id="dateFrom" type="date" aria-label="From date"><input id="dateTo" type="date" aria-label="To date">
          <button id="applyFilters" class="secondary">Apply</button>
        </section>
        <p id="libraryStatus" class="status" role="status"></p>
        <section id="bookmarkGrid" class="bookmark-grid"></section>
      </main>
    </div>
    <dialog id="bookmarkDialog">
      <form id="bookmarkForm" method="dialog" class="stack">
        <h2 id="bookmarkDialogTitle">Add bookmark</h2>
        <input id="bookmarkId" type="hidden"><input id="bookmarkRevision" type="hidden">
        <input id="relatedBookmarkId" type="hidden">
        <label>URL<input id="bookmarkUrl" type="url" required></label>
        <label>Linked to <small>Optional related bookmark URL</small><input id="bookmarkLinkedUrl" type="url"></label>
        <label>Title<input id="bookmarkTitle" maxlength="1000"></label>
        <label>Description<textarea id="bookmarkDescription" maxlength="5000"></textarea></label>
        <label>Note<textarea id="bookmarkNote" maxlength="10000"></textarea></label>
        <label>Folder<select id="bookmarkFolder"></select></label>
        <label>Tags<input id="bookmarkTags" placeholder="comma-separated tags"></label>
        <label><input id="bookmarkFavorite" type="checkbox"> Favorite</label>
        <div class="actions"><button value="cancel" class="secondary">Cancel</button><button id="saveBookmarkButton" value="default">Save</button></div>
      </form>
    </dialog>`,
  );
}

export function settingsPage(): Response {
  return page(
    "Settings",
    "settings",
    `${navigation("settings")}
    <main class="settings-shell">
      <header><h1>Settings</h1><p class="muted">Connections, automation, imports, and security.</p></header>
      <div class="settings-grid">
        <section class="panel"><h2>AI provider</h2>
          <form id="providerForm" class="stack">
            <label>Provider<select id="providerName"><option value="workers-ai">Cloudflare Workers AI</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
            <label>Model<input id="providerModel" required></label>
            <label id="providerKeyLabel">API key<input id="providerKey" type="password" autocomplete="off"></label>
            <button type="submit">Test and activate</button>
          </form><p id="providerStatus" class="status"></p>
          <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">View account-wide Workers AI usage ↗</a>
        </section>
        <section class="panel"><h2>Automation</h2><p id="automationStatus"></p><button id="automationButton" class="secondary">Pause AI</button></section>
        <section class="panel"><h2>Raindrop CSV import</h2>
          <form id="importForm" class="stack"><input id="importFile" type="file" accept=".csv,text/csv" required>
            <select id="importOption"><option value="reorganize">Reorganize everything</option><option value="preserve">Preserve tags and description</option></select>
            <button type="submit">Preview and import</button>
          </form><p id="importStatus" class="status"></p>
        </section>
        <section class="panel"><h2>Export</h2><p>Download a portable copy of the Later Gator library.</p><a class="button-link" href="/api/export?format=json">Export JSON</a> <a class="button-link secondary" href="/api/export?format=csv">Export CSV</a></section>
        <section class="panel"><h2>Browser extension</h2>
          <input id="extensionName" placeholder="This browser" value="My browser"><button id="pairExtension">Generate connection</button>
          <pre id="extensionCredential" class="secret-output"></pre>
          <p><a href="/extension/chrome" target="_blank">Chrome installation</a> · <a href="/extension/firefox" target="_blank">Firefox installation</a></p>
        </section>
        <section class="panel"><h2>iOS Share Sheet Shortcut</h2><button id="pairIos">Generate iOS connection</button><pre id="iosCredential" class="secret-output"></pre><p><a href="/shortcut/ios" target="_blank">Open guided installation</a></p></section>
        <section class="panel"><h2>MCP</h2><p>Read-only access for ChatGPT or Claude.</p><button id="rotateMcp">Generate or rotate MCP URL</button><pre id="mcpCredential" class="secret-output"></pre></section>
        <section class="panel span-two"><h2>Tags</h2><form id="newTagForm"><input id="newTagName" required maxlength="64" placeholder="New tag"><button>Add</button></form><div id="tagSettings" class="tag-list"></div></section>
      </div>
      <p id="settingsStatus" class="status"></p>
    </main>`,
  );
}
