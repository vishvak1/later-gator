export function appCss(): Response {
  return new Response(
    `:root {
  color-scheme: light;
  --canvas: #f4f1e9;
  --surface: #fffdf8;
  --surface-strong: #ffffff;
  --ink: #17211b;
  --muted: #6e776f;
  --line: #dcded5;
  --accent: #356b43;
  --accent-strong: #224c2d;
  --accent-soft: #dcead9;
  --warm: #e7c987;
  --danger: #a83a32;
  --shadow: 0 18px 50px rgba(33, 46, 36, .11);
  font: 16px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-height: 100%; background: var(--canvas); }
body { min-height: 100vh; margin: 0; background: var(--canvas); color: var(--ink); }
body:has(dialog[open]) { overflow: hidden; }
a { color: var(--accent-strong); }
button, .button-link {
  min-height: 2.7rem;
  border: 0;
  border-radius: .8rem;
  padding: .65rem 1rem;
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-weight: 750;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .35rem;
  transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
}
button:hover, .button-link:hover { transform: translateY(-1px); box-shadow: 0 8px 18px rgba(42, 77, 50, .15); }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 3px solid rgba(53, 107, 67, .22);
  outline-offset: 2px;
}
button:disabled { opacity: .5; cursor: not-allowed; transform: none; box-shadow: none; }
.secondary { background: var(--accent-soft); color: var(--accent-strong); }
.ghost, .text-button { background: transparent; color: var(--ink); box-shadow: none; }
.text-button { padding-inline: .25rem; text-decoration: underline; text-underline-offset: .2rem; }
.danger { background: var(--danger); }
.wide { width: 100%; }
input, textarea, select {
  width: 100%;
  min-height: 2.8rem;
  padding: .7rem .8rem;
  border: 1px solid var(--line);
  border-radius: .72rem;
  background: var(--surface-strong);
  color: var(--ink);
  font: inherit;
}
textarea { min-height: 6.5rem; resize: vertical; }
label { display: grid; gap: .38rem; font-weight: 680; }
label small { color: var(--muted); font-weight: 500; }
label:has(input[type="checkbox"]), label:has(input[type="radio"]) {
  display: flex;
  align-items: center;
  font-weight: 520;
}
input[type="checkbox"], input[type="radio"] { width: auto; min-height: auto; accent-color: var(--accent); }
h1, h2, h3, p { overflow-wrap: anywhere; }
h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.35rem); line-height: 1.02; letter-spacing: -.045em; }
h2 { letter-spacing: -.02em; }
.muted { color: var(--muted); }
.error { color: var(--danger); }
.status { min-height: 1.5rem; }
.eyebrow, .sidebar-label {
  margin: 0 0 .35rem;
  color: var(--accent);
  font-size: .73rem;
  font-weight: 850;
  letter-spacing: .11em;
  text-transform: uppercase;
}
.stack { display: grid; gap: 1rem; }
.panel {
  background: var(--surface);
  border: 1px solid rgba(207, 211, 200, .85);
  border-radius: 1.15rem;
  padding: 1.35rem;
  box-shadow: 0 5px 20px rgba(40, 54, 42, .045);
}
.panel h2 { margin-top: 0; }
.logo { font-size: 3rem; }
.logo.small { font-size: 2rem; }
.auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 2rem; }
.auth-card {
  width: min(29rem, 100%);
  background: var(--surface);
  padding: 2.4rem;
  border: 1px solid var(--line);
  border-radius: 1.4rem;
  box-shadow: var(--shadow);
}
.setup-shell, .settings-shell { max-width: 76rem; margin: auto; padding: 2rem; }
.setup-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 2rem; }
.topic-onboarding { background: linear-gradient(145deg, #fffdf8 0%, #f0f6eb 100%); }
.topic-picker { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; margin-top: 1.15rem; }
.topic-picker fieldset { min-width: 0; margin: 0; padding: .85rem; border: 1px solid var(--line); border-radius: 1rem; background: rgba(255, 255, 255, .72); }
.topic-picker legend { padding: 0 .35rem; color: var(--accent-strong); font-weight: 850; }
.topic-options { display: flex; flex-wrap: wrap; gap: .45rem; }
.topic-chip { min-height: 2.2rem; padding: .42rem .7rem; border: 1px solid var(--line); background: #fff; color: var(--ink); font-size: .82rem; }
.topic-chip.selected { border-color: var(--accent); background: var(--accent); color: #fff; box-shadow: 0 7px 16px rgba(45, 91, 55, .18); }
.custom-topic { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .55rem; margin-top: .85rem; }
.custom-topic-tokens { margin-top: .55rem; }
.selection-count { margin: .7rem 0 0; color: var(--muted); font-weight: 700; }
.step {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: var(--accent-soft);
  font-weight: 850;
}
.screenshot-placeholder {
  display: grid;
  place-items: center;
  min-height: 10rem;
  margin: .75rem 0;
  border: 2px dashed var(--line);
  border-radius: .9rem;
  color: var(--muted);
  background: #faf9f4;
}
.topbar {
  height: 4.6rem;
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  gap: 2rem;
  background: rgba(255, 253, 248, .9);
  border-bottom: 1px solid rgba(211, 214, 205, .9);
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(16px);
}
.topbar nav { display: flex; gap: .35rem; flex: 1; }
.topbar nav a { padding: .55rem .78rem; text-decoration: none; color: var(--muted); border-radius: .65rem; }
.topbar nav a[aria-current="page"] { color: var(--ink); background: var(--accent-soft); }
.brand { text-decoration: none; font-weight: 900; color: var(--ink); font-size: 1.08rem; }
.app-layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); min-height: calc(100vh - 4.6rem); }
.sidebar {
  padding: 1.3rem 1rem;
  border-right: 1px solid var(--line);
  background: #ece9df;
  position: sticky;
  top: 4.6rem;
  height: calc(100vh - 4.6rem);
  overflow: auto;
}
.add-button { box-shadow: 0 9px 24px rgba(39, 81, 49, .2); }
.sidebar-label { margin: 1.5rem .7rem .45rem; color: var(--muted); }
.sidebar nav { display: grid; gap: .2rem; }
.sidebar nav button {
  justify-content: flex-start;
  background: transparent;
  color: var(--ink);
  text-align: left;
  font-weight: 600;
  padding: .6rem .7rem;
}
.folder-nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-count { margin-left: auto; color: var(--muted); font-size: .72rem; font-variant-numeric: tabular-nums; }
.sidebar nav button.active { background: var(--surface); box-shadow: 0 3px 12px rgba(45, 55, 46, .07); }
.sidebar-section-heading { display: flex; align-items: end; justify-content: space-between; gap: .5rem; margin-top: .7rem; }
.sidebar-section-heading .compact { min-height: auto; padding: .15rem .3rem; font-size: .72rem; }
.tag-navigation { padding-right: .15rem; }
.tag-nav-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .25rem; }
.tag-nav-row .tag-filter { min-width: 0; justify-content: space-between; }
.tag-nav-row .tag-filter span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-nav-row .tag-count { color: var(--muted); font-size: .7rem; }
.tag-nav-row .tag-delete { min-height: 1.9rem; width: 1.9rem; padding: 0; color: var(--danger); justify-content: center; }
.topics-dialog { width: min(46rem, calc(100% - 2rem)); }
.all-tag-navigation { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .35rem; max-height: min(65vh, 38rem); overflow: auto; padding: .2rem; }
.library { padding: clamp(1.25rem, 3vw, 2.5rem); min-width: 0; }
.library-header { display: flex; justify-content: space-between; align-items: end; gap: 1rem; }
.library-header h1 { max-width: 16ch; }
.header-actions { display: flex; align-items: center; gap: .7rem; }
.mode-badge { padding: .34rem .6rem; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: .78rem; font-weight: 750; }
.mode-badge.active { border-color: var(--warm); background: #fff4d8; color: #684c14; }
.discovery-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; margin: 1.6rem 0 .65rem; }
.search-shell { position: relative; display: flex; align-items: center; }
.search-shell > span { position: absolute; left: 1rem; z-index: 1; color: var(--muted); font-size: 1.35rem; }
.search-shell input { height: 3.3rem; padding-left: 2.8rem; border-radius: 1rem; box-shadow: 0 7px 24px rgba(40, 53, 42, .06); }
.filter-button { min-width: 9.5rem; }
.filter-button span:not(:empty) { display: inline-grid; place-items: center; min-width: 1.35rem; height: 1.35rem; border-radius: 999px; background: var(--accent); color: #fff; font-size: .72rem; }
.suggestion-menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + .35rem);
  left: 0;
  right: 0;
  max-height: 17rem;
  overflow: auto;
  padding: .4rem;
  border: 1px solid var(--line);
  border-radius: .85rem;
  background: var(--surface-strong);
  box-shadow: var(--shadow);
}
.suggestion-menu button { width: 100%; min-height: 2.2rem; justify-content: flex-start; background: transparent; color: var(--ink); }
.suggestion-menu button:hover { background: var(--accent-soft); transform: none; box-shadow: none; }
.selected-tags { display: flex; flex-wrap: wrap; gap: .4rem; min-height: .2rem; }
.selected-tags button, .chip {
  min-height: auto;
  border-radius: 999px;
  padding: .25rem .58rem;
  background: #e8eee3;
  color: var(--accent-strong);
  font-size: .76rem;
  font-weight: 750;
  box-shadow: none;
}
.bookmark-grid { columns: 19rem; column-gap: 1rem; padding-top: .5rem; }
.load-more-wrap { display: flex; justify-content: center; padding: 1.2rem 0 2rem; }
.bookmark-card {
  background: var(--surface);
  border: 1px solid rgba(208, 211, 201, .9);
  border-radius: 1rem;
  overflow: hidden;
  display: inline-block;
  width: 100%;
  margin: 0 0 1rem;
  break-inside: avoid;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(37, 49, 39, .045);
  transition: transform .18s ease, box-shadow .18s ease;
}
.bookmark-card:hover { transform: translateY(-3px); box-shadow: 0 15px 34px rgba(37, 49, 39, .12); }
.thumbnail { display: block; background: linear-gradient(135deg, #e5efd9, #c9ddba); object-fit: contain; width: 100%; height: auto; }
.thumbnail.placeholder { aspect-ratio: 16/10; }
.bookmark-content { padding: .95rem 1rem 1.05rem; }
.card-kicker { display: flex; justify-content: space-between; gap: .5rem; color: var(--muted); font-size: .72rem; }
.bookmark-content h2 { font-size: 1.02rem; line-height: 1.32; margin: .42rem 0 .65rem; letter-spacing: -.015em; }
.bookmark-content .chips { max-height: 3.3rem; overflow: hidden; }
.chips { display: flex; flex-wrap: wrap; gap: .35rem; }
.card-date { margin-top: .72rem; color: var(--muted); font-size: .73rem; }
.empty-state { padding: 4rem 1rem; text-align: center; color: var(--muted); column-span: all; }
dialog {
  border: 1px solid rgba(207, 211, 200, .95);
  border-radius: 1.25rem;
  width: min(48rem, calc(100% - 2rem));
  max-height: calc(100vh - 2rem);
  padding: 1.4rem;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 28px 90px rgba(17, 27, 20, .3);
}
dialog::backdrop { background: rgba(20, 29, 23, .62); backdrop-filter: blur(4px); }
.filter-dialog { width: min(43rem, calc(100% - 2rem)); }
.dialog-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.dialog-heading h2 { margin: 0; font-size: 1.65rem; }
.icon-button { width: 2.55rem; min-height: 2.55rem; padding: 0; border-radius: 999px; background: #ecefe8; color: var(--ink); font-size: 1.45rem; }
.filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; }
.actions { display: flex; justify-content: flex-end; align-items: center; gap: .5rem; }
.actions.split { justify-content: space-between; }
.detail-preview { margin: 1.1rem -1.4rem; max-height: 28rem; overflow: hidden; background: #e8ece3; }
.detail-preview img { width: 100%; max-height: 28rem; object-fit: contain; display: block; margin: auto; }
.detail-description { font-size: 1.05rem; color: #3e4840; }
.metadata-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; margin: 1rem 0 1.3rem; }
.metadata-grid > div { padding: .8rem; background: #f3f2ec; border-radius: .8rem; }
.metadata-grid span { display: block; color: var(--muted); font-size: .7rem; font-weight: 850; text-transform: uppercase; letter-spacing: .08em; }
.metadata-grid p { margin: .3rem 0 0; white-space: pre-wrap; }
.span-two { grid-column: 1 / -1; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.secret-output { white-space: pre-wrap; word-break: break-all; background: #17251b; color: #def1d8; padding: 1rem; border-radius: .7rem; min-height: 2.5rem; }
.tag-list { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
.tag-row { display: flex; align-items: center; gap: .4rem; background: #eff1eb; border-radius: 999px; padding: .3rem .4rem .3rem .7rem; }
.tag-row button { min-height: auto; padding: .2rem .5rem; font-size: .75rem; }
.danger-zone { border-color: rgba(168, 58, 50, .35); background: #fff8f5; }
.busy-overlay {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(24, 32, 26, .66);
  backdrop-filter: grayscale(.5) blur(6px);
}
.busy-overlay[hidden] { display: none; }
.busy-overlay.import-progress {
  inset: auto 1rem 1rem auto;
  display: block;
  width: min(30rem, calc(100% - 2rem));
  padding: 0;
  background: transparent;
  backdrop-filter: none;
  pointer-events: none;
}
.busy-overlay.import-progress .busy-card {
  width: 100%;
  padding: 1.15rem;
  border: 1px solid var(--line);
  text-align: left;
  pointer-events: auto;
}
.busy-overlay.import-progress .import-mark { display: none; }
.busy-card {
  width: min(42rem, 100%);
  max-height: calc(100vh - 2rem);
  overflow: auto;
  padding: 1.7rem;
  border-radius: 1.2rem;
  background: var(--surface);
  box-shadow: var(--shadow);
  text-align: center;
}
.busy-card h2 { margin: .15rem 0; font-size: 1.65rem; }
.import-mark { display: inline-grid; place-items: center; width: 3.2rem; height: 3.2rem; border-radius: 1rem; background: var(--accent-soft); color: var(--accent); font-size: 1.7rem; font-weight: 900; }
.progress-track { height: .65rem; margin: 1.2rem 0 .45rem; overflow: hidden; border-radius: 999px; background: #e2e4dd; }
.progress-track span { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), #78a65c); transition: width .3s ease; }
.progress-label { min-height: 1.5rem; color: var(--muted); font-size: .85rem; }
.automation-progress .progress-track { margin-top: .8rem; }
.progress-states { display: flex; flex-wrap: wrap; gap: .4rem; }
.progress-state { padding: .25rem .55rem; border-radius: 999px; background: #edf1e9; color: var(--muted); font-size: .76rem; font-weight: 700; }
.inline-import-progress { padding: .9rem; border: 1px solid var(--line); border-radius: .85rem; background: #f4f7f0; }
.duplicate-decision { text-align: left; margin-top: 1rem; }
.comparison-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin: .75rem 0 1rem; }
.comparison-grid article { min-width: 0; padding: .9rem; border: 1px solid var(--line); border-radius: .85rem; background: #f6f5ef; }
.comparison-grid span { display: block; color: var(--muted); font-size: .7rem; font-weight: 800; text-transform: uppercase; }
.comparison-grid strong, .comparison-grid small { display: block; margin-top: .35rem; overflow-wrap: anywhere; }
.comparison-grid small { color: var(--muted); }
.check-row { justify-content: center; margin: .75rem 0; }
.import-controls { display: flex; justify-content: center; gap: .5rem; }
body.import-readonly #addBookmarkButton,
body.import-readonly #editDetailButton,
body.import-readonly #restoreDetailButton,
body.import-readonly #deleteDetailButton,
body.import-readonly #bookmarkForm,
body.import-readonly .settings-grid form:not(#importForm),
body.import-readonly .settings-grid button:not(#retryImportButton):not(#resetApplicationButton) {
  opacity: .45;
  pointer-events: none;
}
@media (max-width: 900px) {
  .app-layout { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .sidebar nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .all-tag-navigation { grid-template-columns: 1fr; }
  .settings-grid { grid-template-columns: 1fr; }
  .span-two { grid-column: auto; }
}
@media (max-width: 620px) {
  .topbar { gap: .5rem; padding: 0 .75rem; }
  .brand { font-size: 0; }
  .brand span { font-size: 1.5rem; }
  .library, .setup-shell, .settings-shell { padding: 1rem; }
  .library-header { align-items: flex-start; }
  .header-actions { flex-direction: column; align-items: flex-end; }
  .discovery-bar, .filter-grid, .metadata-grid, .comparison-grid, .topic-picker, .custom-topic { grid-template-columns: 1fr; }
  .bookmark-grid { columns: 1; }
  .actions.split { align-items: stretch; flex-direction: column; }
}`,
    {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export function appJs(): Response {
  return new Response(
    `"use strict";
const page = document.body.dataset.page;
const csrf = () => document.cookie.split("; ").find(value => value.startsWith("lg_csrf="))?.slice(8) ?? "";

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  if (options.method && options.method !== "GET") headers.set("x-csrf-token", csrf());
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    location.replace("/");
    throw new ApiError("Session expired", 401, "unauthenticated");
  }
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new ApiError(body?.error?.message || "Request failed", response.status, body?.error?.code || "request_failed");
  }
  return body;
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function normalizeTag(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\\p{L}\\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function tagValues(value) {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function friendlyDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function logout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    location.replace("/");
  }
}

document.querySelector("#logoutButton")?.addEventListener("click", logout);

let currentImportId = null;
let importRecoveryRequest = null;

function setImportOverlay(visible, title, message, mode = "modal") {
  const overlay = document.querySelector("#importOverlay");
  if (!overlay) return;
  overlay.hidden = !visible;
  overlay.classList.toggle("import-progress", visible && mode === "progress");
  document.body.classList.toggle("import-readonly", visible && mode === "progress");
  const card = overlay.querySelector(".busy-card");
  card.setAttribute("aria-modal", mode === "modal" ? "true" : "false");
  if (title) document.querySelector("#importOverlayTitle").textContent = title;
  if (message !== undefined) document.querySelector("#importOverlayMessage").textContent = message;
  const settingsProgress = document.querySelector("#settingsImportProgress");
  const settingsForm = document.querySelector("#importForm");
  if (settingsProgress && settingsForm) {
    const showProgress = visible && mode === "progress";
    settingsProgress.hidden = !showProgress;
    settingsForm.hidden = showProgress;
    if (title) document.querySelector("#settingsImportTitle").textContent = title;
  }
}

function setImportProgress(status) {
  const wrap = document.querySelector("#importProgressWrap");
  const bar = document.querySelector("#importProgressBar");
  const label = document.querySelector("#importProgressLabel");
  const total = Number(status.valid_rows || 0);
  const processed = Number(status.processed_rows || 0);
  const percentage = total === 0 ? 100 : Math.min(100, Math.round(processed / total * 100));
  wrap.hidden = false;
  bar.style.width = percentage.toString() + "%";
  label.textContent = processed.toString() + " of " + total.toString() + " bookmarks processed" +
    (Number(status.duplicate_rows || 0) > 0 ? " · " + status.duplicate_rows.toString() + " duplicate rows skipped" : "") +
    (Number(status.invalid_rows || 0) > 0 ? " · " + status.invalid_rows.toString() + " invalid rows skipped" : "");
  const settingsBar = document.querySelector("#settingsImportProgressBar");
  const settingsLabel = document.querySelector("#settingsImportProgressLabel");
  if (settingsBar && settingsLabel) {
    settingsBar.style.width = percentage.toString() + "%";
    settingsLabel.textContent = label.textContent;
  }
}

function chooseDuplicateActions(duplicates) {
  if (duplicates.length === 0) return Promise.resolve([]);
  const panel = document.querySelector("#duplicateDecision");
  const progress = document.querySelector("#importProgressWrap");
  const cancel = document.querySelector("#cancelImportButton");
  panel.hidden = false;
  progress.hidden = true;
  cancel.hidden = false;
  const decisions = [];
  let index = 0;

  return new Promise(resolve => {
    const show = () => {
      const duplicate = duplicates[index];
      document.querySelector("#duplicateCounter").textContent = "Duplicate " + (index + 1).toString() + " of " + duplicates.length.toString();
      document.querySelector("#existingDuplicateTitle").textContent = duplicate.existingTitle || "Untitled bookmark";
      document.querySelector("#existingDuplicateUrl").textContent = duplicate.existingUrl;
      document.querySelector("#importedDuplicateTitle").textContent = duplicate.importedTitle || "Untitled bookmark";
      document.querySelector("#importedDuplicateUrl").textContent = duplicate.importedUrl;
    };
    const decide = action => {
      const applyAll = document.querySelector("#duplicateApplyAll").checked;
      if (applyAll) {
        for (; index < duplicates.length; index += 1) {
          decisions.push({ rowNumber: duplicates[index].rowNumber, action });
        }
      } else {
        decisions.push({ rowNumber: duplicates[index].rowNumber, action });
        index += 1;
      }
      if (index >= duplicates.length) {
        panel.hidden = true;
        cancel.hidden = true;
        resolve(decisions);
      } else {
        show();
      }
    };
    document.querySelector("#duplicateUseCurrent").onclick = () => decide("use_current");
    document.querySelector("#duplicateReplace").onclick = () => decide("replace");
    show();
  });
}

async function waitForImport(importId) {
  let lastProcessed = -1;
  let lastProgressAt = Date.now();
  let lastRecoveryAt = 0;
  const retry = document.querySelector("#retryImportButton");
  const requestRecovery = async () => {
    if (importRecoveryRequest !== null) return importRecoveryRequest;
    importRecoveryRequest = api("/api/imports/" + importId + "/commit", {
      method: "POST",
      body: JSON.stringify({ duplicateDecisions: [] }),
    }).finally(() => {
      importRecoveryRequest = null;
    });
    return importRecoveryRequest;
  };
  retry.onclick = async () => {
    retry.disabled = true;
    document.querySelector("#importOverlayMessage").textContent =
      "Requesting another safe import pass…";
    try {
      await requestRecovery();
      lastRecoveryAt = Date.now();
    } catch (error) {
      document.querySelector("#importOverlayMessage").textContent = error.message;
    } finally {
      retry.disabled = false;
    }
  };
  for (;;) {
    try {
      const result = await api("/api/imports/" + importId);
      const status = result.import;
      setImportProgress(status);
      const processed = Number(status.processed_rows || 0);
      if (processed !== lastProcessed) {
        lastProcessed = processed;
        lastProgressAt = Date.now();
        retry.hidden = true;
        document.querySelector("#importOverlayTitle").textContent = "Import in progress";
        document.querySelector("#importOverlayMessage").textContent =
          "You can browse your library while changes remain read-only.";
      }
      if (status.status === "committed") {
        document.querySelector("#importOverlayTitle").textContent = "Import complete";
        document.querySelector("#importOverlayMessage").textContent =
          "Your bookmarks are ready. AI will follow your current pause setting.";
        retry.hidden = true;
        await delay(650);
        setImportOverlay(false);
        currentImportId = null;
        return status;
      }
      if (status.status === "cancelled" || status.status === "expired") {
        setImportOverlay(false);
        currentImportId = null;
        return status;
      }
      const stalledFor = Date.now() - lastProgressAt;
      if (stalledFor >= 30000 && Date.now() - lastRecoveryAt >= 30000) {
        lastRecoveryAt = Date.now();
        document.querySelector("#importOverlayTitle").textContent =
          "Import is taking longer than expected";
        document.querySelector("#importOverlayMessage").textContent =
          "No progress was reported for 30 seconds. Resume asks the queue to continue unfinished rows; it does not restart or duplicate the import.";
        retry.hidden = false;
        await requestRecovery().catch(() => undefined);
      }
    } catch (error) {
      document.querySelector("#importOverlayTitle").textContent = "Import status unavailable";
      document.querySelector("#importOverlayMessage").textContent = error.message;
      retry.hidden = false;
    }
    await delay(850);
  }
}

async function continueImport(importState) {
  currentImportId = importState.id;
  const committing = importState.status === "committing";
  setImportOverlay(
    true,
    committing ? "Import in progress" : "Resume Raindrop import",
    committing
      ? "You can browse your library while changes remain read-only."
      : "Resolve duplicate bookmarks to continue.",
    committing ? "progress" : "modal",
  );
  if (importState.status === "preview") {
    document.querySelector("#cancelImportButton").hidden = true;
    await api("/api/imports/" + importState.id + "/commit", {
      method: "POST",
      body: JSON.stringify({ duplicateDecisions: [] }),
    });
  } else if (committing) {
    await api("/api/imports/" + importState.id + "/commit", {
      method: "POST",
      body: JSON.stringify({ duplicateDecisions: [] }),
    });
  }
  setImportOverlay(
    true,
    "Import in progress",
    "You can browse your library while changes remain read-only.",
    "progress",
  );
  return waitForImport(importState.id);
}

async function commitImport(file, option, statusNode) {
  if (!file) throw new Error("Choose a Raindrop CSV first.");
  setImportOverlay(true, "Checking your Raindrop export", "Looking for valid bookmarks and duplicates…");
  document.querySelector("#cancelImportButton").hidden = true;
  document.querySelector("#importProgressWrap").hidden = true;
  const form = new FormData();
  form.set("file", file);
  form.set("option", option);
  const preview = await api("/api/imports/preview", { method: "POST", body: form });
  currentImportId = preview.preview.importId;
  if (statusNode) {
    statusNode.textContent = preview.preview.validRows.toString() + " ready, " +
      preview.preview.duplicateRows.toString() + " duplicate rows skipped, " +
      preview.preview.invalidRows.toString() + " invalid.";
  }
  document.querySelector("#importOverlayTitle").textContent =
    "Ready to import";
  document.querySelector("#importOverlayMessage").textContent =
    "Duplicate URLs inside the CSV will be skipped. Existing library bookmarks are kept unchanged.";
  document.querySelector("#cancelImportButton").hidden = true;
  setImportOverlay(
    true,
    "Importing bookmarks",
    "Adding every accepted bookmark to Unsorted in one database operation…",
    "progress",
  );
  await api("/api/imports/" + currentImportId + "/commit", {
    method: "POST",
    body: JSON.stringify({ duplicateDecisions: [] }),
  });
  setImportOverlay(
    true,
    "Import in progress",
    "You can browse your library while changes remain read-only.",
    "progress",
  );
  return waitForImport(currentImportId);
}

document.querySelector("#cancelImportButton")?.addEventListener("click", async () => {
  if (!currentImportId) return;
  try {
    await api("/api/imports/" + currentImportId + "/cancel", { method: "POST", body: "{}" });
    setImportOverlay(false);
    currentImportId = null;
  } catch (error) {
    document.querySelector("#importOverlayMessage").textContent = error.message;
  }
});

async function restoreActiveImport() {
  if (page === "login") return;
  const result = await api("/api/bootstrap");
  if (result.state.activeImport) {
    const status = await continueImport(result.state.activeImport);
    if (page === "setup" && status.status === "committed") location.replace("/dashboard");
  }
}

if (page === "setup") {
  void restoreActiveImport();
  const selectedTopics = new Set();
  const customTopics = new Set();
  const typedTopics = () => tagValues(document.querySelector("#customTopic").value);
  const allSelectedTopics = () => {
    const topics = new Set([...selectedTopics, ...customTopics, ...typedTopics()]);
    return [...topics].slice(0, 20);
  };
  const renderCustomTopics = () => {
    const container = document.querySelector("#customTopicTokens");
    container.innerHTML = [...customTopics].map(topic =>
      '<button type="button" class="topic-chip selected" data-custom-topic="' +
      escapeHtml(topic) + '">' + escapeHtml(topic) + " ×</button>"
    ).join("");
    container.querySelectorAll("[data-custom-topic]").forEach(button => button.addEventListener("click", () => {
      customTopics.delete(button.dataset.customTopic);
      renderCustomTopics();
      syncTopics();
    }));
  };
  const syncTopics = () => {
    document.querySelectorAll(".topic-chip").forEach(button => {
      if (button.dataset.customTopic) return;
      button.classList.toggle("selected", selectedTopics.has(button.dataset.topic));
      button.setAttribute("aria-pressed", selectedTopics.has(button.dataset.topic) ? "true" : "false");
    });
    const count = allSelectedTopics().length;
    document.querySelector("#topicSelectionCount").textContent =
      count.toString() + " selected" +
      (count < 5 ? " · choose at least 5" : count >= 20 ? " · maximum 20" : " · ready");
    document.querySelector("#finishSetupButton").disabled = count < 5;
  };
  document.querySelectorAll(".topic-chip[data-topic]").forEach(button => button.addEventListener("click", () => {
    const topic = button.dataset.topic;
    if (selectedTopics.has(topic)) selectedTopics.delete(topic);
    else if (allSelectedTopics().length < 20) selectedTopics.add(topic);
    syncTopics();
  }));
  document.querySelector("#customTopic").addEventListener("input", syncTopics);
  document.querySelector("#addCustomTopic").addEventListener("click", () => {
    const input = document.querySelector("#customTopic");
    const existingTopics = new Set([...selectedTopics, ...customTopics]);
    const available = Math.max(0, 20 - existingTopics.size);
    typedTopics()
      .filter(topic => !existingTopics.has(topic))
      .slice(0, available)
      .forEach(topic => customTopics.add(topic));
    input.value = "";
    renderCustomTopics();
    syncTopics();
  });
  document.querySelector("#customTopic").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      document.querySelector("#addCustomTopic").click();
    }
  });
  syncTopics();
  document.querySelector("#setupForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = document.querySelector("#setupStatus");
    try {
      status.className = "status";
      status.textContent = "Saving profile…";
      await api("/api/setup/complete", {
        method: "POST",
        body: JSON.stringify({
          relevantTags: allSelectedTopics(),
          careerContext: document.querySelector("#careerContext").value,
          aspirationContext: document.querySelector("#aspirationContext").value,
          personalInstructions: document.querySelector("#personalInstructions").value || null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
      });
      const file = document.querySelector("#setupImportFile").files[0];
      if (file) {
        const option = document.querySelector("input[name=setupImportOption]:checked").value;
        await commitImport(file, option, status);
      }
      location.replace("/dashboard");
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
      if (currentImportId === null) setImportOverlay(false);
    }
  });
}

let bootstrap = null;
let currentFolder = null;
let selectedSearchTags = new Map();
let currentBookmark = null;
let searchTimer = null;
let nextBookmarkCursor = null;
let loadedBookmarkCount = 0;

async function loadBootstrap() {
  bootstrap = (await api("/api/bootstrap")).state;
  const siteOptions = document.querySelector("#siteOptions");
  if (siteOptions) {
    siteOptions.innerHTML = (bootstrap.sites || []).map(site => '<option value="' + escapeHtml(site) + '"></option>').join("");
  }
  return bootstrap;
}

function folderOptions() {
  return bootstrap.folders
    .filter(folder => folder.slug !== "imports")
    .map(folder => '<option value="' + folder.id + '">' + escapeHtml(folder.name) + "</option>")
    .join("");
}

function renderFolders() {
  const nav = document.querySelector("#folderNavigation");
  const visibleFolders = bootstrap.folders.filter(folder => folder.slug !== "imports");
  const allCount = bootstrap.folders.reduce(
    (total, folder) => total + Number(folder.bookmark_count || 0),
    0,
  );
  const items = [
    { id: null, name: "All Bookmarks", count: allCount },
    ...visibleFolders.map(folder => ({ ...folder, count: Number(folder.bookmark_count || 0) })),
    { id: "trash", name: "Trash", count: Number(bootstrap.trashCount || 0) },
  ];
  nav.innerHTML = items.map(item =>
    '<button type="button" data-folder="' + (item.id ?? "") + '" data-folder-name="' +
    escapeHtml(item.name) + '" class="' + (currentFolder === item.id ? "active" : "") + '">' +
    '<span class="folder-nav-label">' + escapeHtml(item.name) + '</span><span class="folder-count">' +
    Number(item.count).toString() + "</span></button>"
  ).join("");
  nav.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    currentFolder = button.dataset.folder || null;
    document.querySelector("#libraryTitle").textContent = button.dataset.folderName;
    renderFolders();
    void loadBookmarks();
  }));
  document.querySelector("#bookmarkFolder").innerHTML = folderOptions();
}

function bindTagNavigation(nav) {
  nav.querySelectorAll("[data-filter-tag]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.filterTag;
    if (selectedSearchTags.has(key)) selectedSearchTags.delete(key);
    else selectedSearchTags.set(key, button.dataset.filterDisplay);
    renderTagNavigation();
    renderSelectedTags();
    document.querySelector("#topicsDialog")?.close();
    void loadBookmarks();
  }));
  nav.querySelectorAll("[data-delete-tag]").forEach(button => button.addEventListener("click", async () => {
    const count = Number(button.dataset.deleteCount);
    if (!confirm("Delete #" + button.dataset.deleteName + " from " + count.toString() +
      " bookmark" + (count === 1 ? "" : "s") + "? The bookmarks will remain.")) return;
    await api("/api/tags/" + button.dataset.deleteTag, { method: "DELETE" });
    selectedSearchTags.delete(button.dataset.deleteName.toLocaleLowerCase("en-US"));
    await loadBootstrap();
    renderTagNavigation();
    renderSelectedTags();
    await loadBookmarks();
  }));
}

function tagNavigationMarkup(tags) {
  return tags.map(tag =>
    '<div class="tag-nav-row"><button type="button" class="tag-filter ' +
    (selectedSearchTags.has(tag.normalized_name) ? "active" : "") +
    '" data-filter-tag="' + escapeHtml(tag.normalized_name) + '" data-filter-display="' +
    escapeHtml(tag.display_name) + '"><span>#' + escapeHtml(tag.display_name) +
    '</span><span class="tag-count">' + Number(tag.usage_count).toString() +
    '</span></button><button type="button" class="tag-delete text-button" data-delete-tag="' +
    tag.id + '" data-delete-name="' + escapeHtml(tag.display_name) +
    '" data-delete-count="' + Number(tag.usage_count).toString() +
    '" aria-label="Delete tag ' + escapeHtml(tag.display_name) + '">×</button></div>'
  ).join("") || '<p class="muted">Topics appear here as your library grows.</p>';
}

function renderTagNavigation() {
  const nav = document.querySelector("#tagNavigation");
  const allNav = document.querySelector("#allTagNavigation");
  const tags = bootstrap.tags
    .filter(tag => tag.status === "active")
    .sort((left, right) => Number(right.usage_count) - Number(left.usage_count) ||
      left.display_name.localeCompare(right.display_name));
  nav.innerHTML = tagNavigationMarkup(tags.slice(0, 8));
  bindTagNavigation(nav);
  if (allNav) {
    allNav.innerHTML = tagNavigationMarkup(tags);
    bindTagNavigation(allNav);
  }
  document.querySelector("#viewAllTopicsButton").hidden = tags.length === 0;
}

function searchQuery(cursor = null) {
  const params = new URLSearchParams({
    sort: document.querySelector("#sortSelect").value,
    direction: document.querySelector("#directionSelect").value,
    limit: "48",
  });
  const q = document.querySelector("#searchInput").value.trim();
  const site = document.querySelector("#siteInput").value.trim();
  const favorite = document.querySelector("#favoriteFilter").value;
  if (q) params.set("q", q.replace(/#[^\\s#]*/g, "").trim());
  if (site) params.set("hostname", site);
  if (favorite) params.set("favorite", favorite);
  if (selectedSearchTags.size > 0) params.set("tags", [...selectedSearchTags.keys()].join(","));
  if (currentFolder === "trash") params.set("includeTrash", "true");
  else if (currentFolder) params.set("folder", currentFolder);
  const from = document.querySelector("#dateFrom").value;
  const to = document.querySelector("#dateTo").value;
  const field = document.querySelector("#dateField").value;
  if (from) {
    params.set("dateField", field);
    params.set("dateFrom", from + "T00:00:00.000Z");
  }
  if (to) {
    params.set("dateField", field);
    params.set("dateTo", to + "T23:59:59.999Z");
  }
  if (cursor) params.set("cursor", cursor);
  return params;
}

function previewImage(bookmark, className = "thumbnail") {
  if (bookmark.thumbnail_id || bookmark.thumbnailAvailable) {
    const width = Number(bookmark.thumbnail_width) || 960;
    const height = Number(bookmark.thumbnail_height) || 540;
    return '<img class="' + className + '" src="/api/thumbnails/' + bookmark.id + '" width="' +
      width.toString() + '" height="' + height.toString() + '" loading="lazy" decoding="async" alt="">';
  }
  return '<img class="' + className + ' placeholder" src="data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'640\\' height=\\'400\\'%3E%3Crect width=\\'100%25\\' height=\\'100%25\\' fill=\\'%23dfe9d6\\'/%3E%3Ctext x=\\'50%25\\' y=\\'53%25\\' text-anchor=\\'middle\\' fill=\\'%23356b43\\' font-size=\\'52\\'%3E%E2%97%8E%3C/text%3E%3C/svg%3E" width="640" height="400" loading="lazy" alt="">';
}

function cardTags(bookmark) {
  const values = (bookmark.tag_names || "").split(",").filter(Boolean).slice(0, 4);
  return values.map(tag => '<span class="chip">#' + escapeHtml(tag) + "</span>").join("");
}

function bookmarkCards(bookmarks) {
  return bookmarks.map(bookmark =>
    '<article class="bookmark-card" data-id="' + bookmark.id + '" tabindex="0" role="button" aria-label="View ' +
    escapeHtml(bookmark.title) + '">' + previewImage(bookmark) +
    '<div class="bookmark-content"><div class="card-kicker"><span>' + escapeHtml(bookmark.folder_name) +
    '</span><span>' + escapeHtml(bookmark.hostname) + '</span></div><h2>' + escapeHtml(bookmark.title) +
    '</h2><div class="chips">' + cardTags(bookmark) +
    (bookmark.favorite ? '<span class="chip">★ Favorite</span>' : "") +
    '</div><div class="card-date">Added ' + friendlyDate(bookmark.added_at) + "</div></div></article>"
  ).join("");
}

function bindBookmarkCards() {
  document.querySelectorAll(".bookmark-card:not([data-bound])").forEach(card => {
    card.dataset.bound = "true";
    card.addEventListener("click", () => void openBookmark(card.dataset.id));
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openBookmark(card.dataset.id);
      }
    });
  });
}

async function loadBookmarks(append = false) {
  const status = document.querySelector("#libraryStatus");
  status.className = "status";
  status.textContent = append ? "Loading more bookmarks…" : "Loading bookmarks…";
  try {
    const cursor = append ? nextBookmarkCursor : null;
    const result = await api("/api/bookmarks?" + searchQuery(cursor).toString());
    const grid = document.querySelector("#bookmarkGrid");
    const cards = bookmarkCards(result.bookmarks);
    if (append) grid.insertAdjacentHTML("beforeend", cards);
    else grid.innerHTML = cards || '<div class="empty-state"><h2>Nothing here yet</h2><p>Try a different search or add a bookmark.</p></div>';
    loadedBookmarkCount = append
      ? loadedBookmarkCount + result.bookmarks.length
      : result.bookmarks.length;
    nextBookmarkCursor = result.nextCursor;
    document.querySelector("#libraryCount").textContent =
      loadedBookmarkCount.toString() + " of " + Number(result.total).toString() + " bookmarks";
    document.querySelector("#loadMoreBookmarks").hidden = !nextBookmarkCursor;
    bindBookmarkCards();
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
    status.className = "status error";
  }
}

function renderSelectedTags() {
  const container = document.querySelector("#searchTagChips");
  container.innerHTML = [...selectedSearchTags.entries()].map(([normalized, display]) =>
    '<button type="button" data-search-tag="' + escapeHtml(normalized) + '">#' + escapeHtml(display) + " ×</button>"
  ).join("");
  container.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    selectedSearchTags.delete(button.dataset.searchTag);
    renderSelectedTags();
    void loadBookmarks();
  }));
}

function updateTagSuggestions() {
  const input = document.querySelector("#searchInput");
  const menu = document.querySelector("#tagSuggestions");
  const match = input.value.match(/(?:^|\\s)#([^#\\s]*)$/);
  if (!match) {
    menu.hidden = true;
    return;
  }
  const term = (match[1] || "").toLocaleLowerCase("en-US");
  const matches = bootstrap.tags
    .filter(tag => tag.status === "active" && !selectedSearchTags.has(tag.normalized_name))
    .filter(tag => tag.display_name.toLocaleLowerCase("en-US").includes(term))
    .sort((left, right) => Number(right.usage_count) - Number(left.usage_count) ||
      left.display_name.localeCompare(right.display_name));
  menu.innerHTML = matches.map(tag =>
    '<button type="button" data-tag-name="' + escapeHtml(tag.normalized_name) + '" data-tag-display="' +
    escapeHtml(tag.display_name) + '">#' + escapeHtml(tag.display_name) + "</button>"
  ).join("") || '<p class="muted">No matching tags</p>';
  menu.hidden = false;
  menu.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    selectedSearchTags.set(button.dataset.tagName, button.dataset.tagDisplay);
    input.value = input.value.replace(/(?:^|\\s)#[^#\\s]*$/, "").trim();
    menu.hidden = true;
    renderSelectedTags();
    void loadBookmarks();
    input.focus();
  }));
}

function activeFilterCount() {
  return [
    document.querySelector("#siteInput").value,
    document.querySelector("#favoriteFilter").value,
    document.querySelector("#dateFrom").value,
    document.querySelector("#dateTo").value,
    document.querySelector("#sortSelect").value !== "added_at" ? "sort" : "",
    document.querySelector("#directionSelect").value !== "desc" ? "direction" : "",
  ].filter(Boolean).length;
}

function updateFilterCount() {
  const count = activeFilterCount();
  document.querySelector("#filterCount").textContent = count === 0 ? "" : count.toString();
}

function detailTags(detail) {
  return (detail.tags || []).map(tag => '<span class="chip">#' + escapeHtml(tag.display_name) + "</span>").join("") ||
    '<span class="muted">No tags</span>';
}

function showDetail(detail) {
  currentBookmark = detail;
  document.querySelector("#bookmarkDetailView").hidden = false;
  document.querySelector("#bookmarkForm").hidden = true;
  document.querySelector("#detailFolder").textContent = detail.folder_name + (detail.favorite ? " · Favorite" : "");
  document.querySelector("#detailTitle").textContent = detail.title;
  document.querySelector("#detailPreview").innerHTML = previewImage(detail, "thumbnail");
  document.querySelector("#detailDescription").textContent = detail.description || "No description yet.";
  document.querySelector("#detailNote").textContent = detail.note || "No note.";
  document.querySelector("#detailTags").innerHTML = detailTags(detail);
  document.querySelector("#detailSite").textContent = detail.hostname;
  document.querySelector("#detailAdded").textContent = friendlyDate(detail.added_at);
  document.querySelector("#detailCreated").textContent = friendlyDate(detail.source_created_at);
  document.querySelector("#detailModified").textContent = friendlyDate(detail.modified_at);
  document.querySelector("#detailRelationships").innerHTML = (detail.relatedBookmarks || []).map(related =>
    '<a href="' + escapeHtml(related.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(related.title) + "</a>"
  ).join("<br>") || '<span class="muted">None</span>';
  document.querySelector("#detailExternalLink").href = detail.url;
  const inTrash = currentFolder === "trash";
  document.querySelector("#editDetailButton").hidden = inTrash;
  document.querySelector("#restoreDetailButton").hidden = !inTrash;
  document.querySelector("#deleteDetailButton").hidden = !inTrash;
}

async function openBookmark(id) {
  const detail = (await api("/api/bookmarks/" + id)).bookmark;
  showDetail(detail);
  document.querySelector("#bookmarkDialog").showModal();
}

function populateEditor(detail) {
  document.querySelector("#bookmarkDetailView").hidden = true;
  document.querySelector("#bookmarkForm").hidden = false;
  const related = detail?.relatedBookmarks?.[0] || null;
  const linkedInput = document.querySelector("#bookmarkLinkedUrl");
  document.querySelector("#bookmarkId").value = detail?.id || "";
  document.querySelector("#bookmarkRevision").value = detail?.revision || "";
  document.querySelector("#relatedBookmarkId").value = related?.id || "";
  document.querySelector("#bookmarkUrl").value = detail?.url || "";
  linkedInput.value = related?.url || "";
  linkedInput.dataset.original = related?.url || "";
  document.querySelector("#bookmarkTitle").value = detail?.title || "";
  document.querySelector("#bookmarkDescription").value = detail?.description || "";
  document.querySelector("#bookmarkNote").value = detail?.note || "";
  document.querySelector("#bookmarkFolder").innerHTML = folderOptions();
  document.querySelector("#bookmarkFolder").value = detail?.folder_id || "folder_unsorted";
  document.querySelector("#bookmarkTags").value = (detail?.tags || []).map(tag => tag.display_name).join(", ");
  document.querySelector("#bookmarkFavorite").checked = Boolean(detail?.favorite);
  document.querySelector("#bookmarkDialogTitle").textContent = detail ? "Edit bookmark" : "Add bookmark";
  document.querySelector("#saveBookmarkButton").textContent = detail ? "Save changes" : "Add bookmark";
  document.querySelector("#trashBookmarkButton").hidden = !detail;
}

if (page === "dashboard") {
  (async () => {
    await loadBootstrap();
    renderFolders();
    renderTagNavigation();
    await loadBookmarks();
    if (bootstrap.activeImport) {
      await continueImport(bootstrap.activeImport);
      await loadBootstrap();
      renderFolders();
      renderTagNavigation();
      await loadBookmarks();
    }
  })();

  document.querySelector("#searchInput").addEventListener("input", () => {
    updateTagSuggestions();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadBookmarks(), 280);
  });
  document.querySelector("#searchInput").addEventListener("keydown", event => {
    if (event.key === "Escape") document.querySelector("#tagSuggestions").hidden = true;
    if (event.key === "Enter") {
      document.querySelector("#tagSuggestions").hidden = true;
      void loadBookmarks();
    }
  });
  document.addEventListener("click", event => {
    if (!event.target.closest(".search-shell")) document.querySelector("#tagSuggestions").hidden = true;
  });
  document.querySelector("#filterButton").addEventListener("click", () => document.querySelector("#filterDialog").showModal());
  document.querySelector("#filterForm").addEventListener("submit", event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    updateFilterCount();
    document.querySelector("#filterDialog").close();
    void loadBookmarks();
  });
  document.querySelector("#clearFilters").addEventListener("click", () => {
    document.querySelector("#siteInput").value = "";
    document.querySelector("#favoriteFilter").value = "";
    document.querySelector("#sortSelect").value = "added_at";
    document.querySelector("#directionSelect").value = "desc";
    document.querySelector("#dateField").value = "added_at";
    document.querySelector("#dateFrom").value = "";
    document.querySelector("#dateTo").value = "";
    updateFilterCount();
  });
  document.querySelector("#loadMoreBookmarks").addEventListener("click", () => {
    if (nextBookmarkCursor) void loadBookmarks(true);
  });
  document.querySelector("#viewAllTopicsButton").addEventListener("click", () => {
    renderTagNavigation();
    document.querySelector("#topicsDialog").showModal();
  });
  document.querySelector("#closeTopicsDialog").addEventListener("click", () => {
    document.querySelector("#topicsDialog").close();
  });
  document.querySelector("#addBookmarkButton").addEventListener("click", () => {
    document.querySelector("#bookmarkForm").reset();
    currentBookmark = null;
    populateEditor(null);
    document.querySelector("#bookmarkDialog").showModal();
  });
  document.querySelector("#closeBookmarkDialog").addEventListener("click", () => document.querySelector("#bookmarkDialog").close());
  document.querySelector("#editDetailButton").addEventListener("click", () => populateEditor(currentBookmark));
  document.querySelector("#restoreDetailButton").addEventListener("click", async () => {
    await api("/api/bookmarks/" + currentBookmark.id + "/restore", { method: "POST", body: "{}" });
    document.querySelector("#bookmarkDialog").close();
    await loadBookmarks();
  });
  document.querySelector("#deleteDetailButton").addEventListener("click", async () => {
    if (!confirm("Permanently delete this bookmark? This cannot be undone.")) return;
    await api("/api/bookmarks/" + currentBookmark.id + "/delete", { method: "DELETE" });
    document.querySelector("#bookmarkDialog").close();
    await loadBookmarks();
  });
  document.querySelector("#trashBookmarkButton").addEventListener("click", async () => {
    const id = document.querySelector("#bookmarkId").value;
    if (!id || !confirm("Move this bookmark to Trash?")) return;
    await api("/api/bookmarks/" + id + "/trash", { method: "POST", body: "{}" });
    document.querySelector("#bookmarkDialog").close();
    await loadBookmarks();
  });
  document.querySelector("#bookmarkForm").addEventListener("submit", async event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const id = document.querySelector("#bookmarkId").value;
    const oldRelatedId = document.querySelector("#relatedBookmarkId").value;
    const linkedInput = document.querySelector("#bookmarkLinkedUrl");
    const linkedUrl = linkedInput.value.trim();
    const relationshipChanged = linkedUrl !== (linkedInput.dataset.original || "");
    const payload = {
      url: document.querySelector("#bookmarkUrl").value,
      title: document.querySelector("#bookmarkTitle").value || null,
      description: document.querySelector("#bookmarkDescription").value || null,
      note: document.querySelector("#bookmarkNote").value || null,
      folderId: document.querySelector("#bookmarkFolder").value,
      tags: tagValues(document.querySelector("#bookmarkTags").value),
      favorite: document.querySelector("#bookmarkFavorite").checked,
    };
    if (id) {
      payload.expectedRevision = Number(document.querySelector("#bookmarkRevision").value);
      await api("/api/bookmarks/" + id, { method: "PATCH", body: JSON.stringify(payload) });
      if (relationshipChanged && oldRelatedId) {
        await api("/api/bookmarks/" + id + "/relationships/" + oldRelatedId, { method: "DELETE" });
      }
      if (relationshipChanged && linkedUrl) {
        await api("/api/bookmarks/" + id + "/relationships", { method: "POST", body: JSON.stringify({ linkedUrl }) });
      }
    } else {
      payload.linkedUrl = linkedUrl || null;
      await api("/api/bookmarks", { method: "POST", body: JSON.stringify(payload) });
    }
    document.querySelector("#bookmarkDialog").close();
    await loadBootstrap();
    renderFolders();
    renderTagNavigation();
    await loadBookmarks();
  });
}

function showSecret(selector, value) {
  document.querySelector(selector).textContent = value;
}

function renderAutomationProgress() {
  const progress = bootstrap.automationProgress;
  const total = Number(progress.total || 0);
  const complete = Number(progress.complete || 0);
  const percent = total === 0 ? 100 : Math.round((complete / total) * 100);
  const outstanding = Number(progress.pending || 0) + Number(progress.processing || 0);
  let status = "AI sorting is up to date";
  if (bootstrap.ownerAiPaused) status = "AI sorting is paused";
  else if (bootstrap.provider.operational_status === "waiting") status = "AI provider needs attention";
  else if (outstanding > 0) status = "AI is sorting your library";
  else if (Number(progress.review || 0) + Number(progress.failed || 0) > 0) {
    status = "AI sorting finished with items needing attention";
  }
  document.querySelector("#automationStatus").textContent = status;
  document.querySelector("#automationProgressBar").style.width = percent.toString() + "%";
  document.querySelector("#automationProgressLabel").textContent =
    complete.toString() + " of " + total.toString() + " bookmarks organized · " +
    percent.toString() + "%";
  const states = [
    ["Waiting", progress.pending],
    ["Processing", progress.processing],
    ["Provider wait", progress.waitingProvider],
    ["Paused", progress.pausedOwner],
    ["Review", progress.review],
    ["Failed", progress.failed],
  ].filter(([, count]) => Number(count || 0) > 0);
  document.querySelector("#automationProgressStates").innerHTML = states.map(([label, count]) =>
    '<span class="progress-state">' + escapeHtml(label) + " " + Number(count).toString() + "</span>"
  ).join("");
}

async function loadSettings() {
  bootstrap = (await api("/api/bootstrap")).state;
  document.querySelector("#providerName").value = bootstrap.provider.provider;
  document.querySelector("#providerModel").value = bootstrap.provider.model;
  document.querySelector("#providerStatus").textContent =
    bootstrap.provider.operational_status === "waiting"
      ? "AI needs attention: " + (bootstrap.provider.last_safe_error_code || "provider unavailable")
      : "AI provider is ready.";
  renderAutomationProgress();
  document.querySelector("#automationButton").textContent = bootstrap.ownerAiPaused ? "Resume AI" : "Pause AI";
  toggleKey();
  return bootstrap;
}

function toggleKey() {
  document.querySelector("#providerKeyLabel").hidden = document.querySelector("#providerName").value === "workers-ai";
}

if (page === "settings") {
  (async () => {
    await loadSettings();
    if (bootstrap.activeImport) await continueImport(bootstrap.activeImport);
  })();
  window.setInterval(() => {
    if (!document.hidden && currentImportId === null) void loadSettings();
  }, 5000);
  document.querySelector("#providerName").addEventListener("change", toggleKey);
  document.querySelector("#providerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = document.querySelector("#providerStatus");
    status.textContent = "Testing provider…";
    try {
      const provider = document.querySelector("#providerName").value;
      const model = document.querySelector("#providerModel").value;
      const credential = document.querySelector("#providerKey").value || null;
      await api("/api/providers/test", { method: "POST", body: JSON.stringify({ provider, model, credential }) });
      await api("/api/providers/activate", { method: "POST", body: JSON.stringify({ provider, model }) });
      status.textContent = "Provider activated.";
      await loadSettings();
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    }
  });
  document.querySelector("#automationButton").addEventListener("click", async () => {
    await api("/api/automation/pause", {
      method: "PUT",
      body: JSON.stringify({ paused: !bootstrap.ownerAiPaused }),
    });
    await loadSettings();
  });
  document.querySelector("#importForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = document.querySelector("#importStatus");
    try {
      await commitImport(
        document.querySelector("#importFile").files[0],
        document.querySelector("#importOption").value,
        status,
      );
      status.textContent = "Import complete.";
      await loadSettings();
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
      if (currentImportId === null) setImportOverlay(false);
    }
  });
  document.querySelector("#pairExtension").addEventListener("click", async () => {
    const result = await api("/api/capture/credentials", {
      method: "POST",
      body: JSON.stringify({ kind: "extension", name: document.querySelector("#extensionName").value }),
    });
    showSecret("#extensionCredential", "Deployment: " + location.origin + "\\nToken: " + result.credential.token);
  });
  document.querySelector("#pairIos").addEventListener("click", async () => {
    const result = await api("/api/capture/credentials", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", name: "iOS Shortcut" }),
    });
    showSecret("#iosCredential", "Endpoint: " + location.origin + "/api/capture/ios\\nToken: " + result.credential.token);
  });
  document.querySelector("#rotateMcp").addEventListener("click", async () => {
    const result = await api("/api/mcp/rotate", { method: "POST", body: "{}" });
    showSecret("#mcpCredential", result.url);
  });
  document.querySelector("#resetApplicationButton").addEventListener("click", async () => {
    const confirmation = prompt("This permanently deletes the complete Later Gator library and returns to setup. Type DELETE EVERYTHING to continue.");
    if (confirmation !== "DELETE EVERYTHING") return;
    const button = document.querySelector("#resetApplicationButton");
    button.disabled = true;
    button.textContent = "Resetting…";
    try {
      const result = await api("/api/testing/reset", {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      });
      location.replace(result.redirectTo);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Delete everything and restart setup";
      document.querySelector("#settingsStatus").textContent = error.message;
      document.querySelector("#settingsStatus").className = "status error";
    }
  });
}`,
    {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
