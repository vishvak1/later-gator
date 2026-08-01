"use strict";

import type {
  Bookmark,
  TagSummary,
  BookmarkDetail,
  BookmarkPageResponse,
  BootstrapState,
  ImportPreview,
  ImportSession,
} from "./types";

/**
 * Non-null DOM lookups. A missing element is a programming error, not a
 * runtime condition to branch on, so these throw instead of returning null.
 * This is what removes ~230 unchecked `querySelector(...)!` hazards.
 */
function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error("Missing element: " + selector);
  return node;
}

function maybe<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function all<T extends HTMLElement = HTMLElement>(selector: string): T[] {
  return [...document.querySelectorAll<T>(selector)];
}

/** Provider and network failures reach the UI as messages, never as `unknown`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/* ---- Theme ------------------------------------------------------------ */
type Theme = "light" | "dark" | "system";

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // A cookie, not localStorage, so the server can render the right palette on
  // the first paint instead of the page flashing the wrong one.
  document.cookie = "lg_theme=" + theme + "; Path=/; Max-Age=31536000; SameSite=Strict";
  for (const button of all<HTMLButtonElement>("[data-theme-choice]")) {
    const active = button.dataset.themeChoice === theme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function currentTheme(): Theme {
  const match = /(?:^|;\s*)lg_theme=(light|dark|system)(?:;|$)/u.exec(document.cookie);
  return (match?.[1] as Theme | undefined) ?? "system";
}

function initThemeControls(): void {
  applyTheme(currentTheme());
  for (const button of all<HTMLButtonElement>("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      applyTheme((button.dataset.themeChoice ?? "system") as Theme);
    });
  }
}

const page = document.body.dataset.page;
const csrf = () => document.cookie.split("; ").find(value => value.startsWith("lg_csrf="))?.slice(8) ?? "";

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { message?: string; code?: string };
}

async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  if (options.method && options.method !== "GET") headers.set("x-csrf-token", csrf());
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    location.replace("/");
    throw new ApiError("Session expired", 401, "unauthenticated");
  }
  const type = response.headers.get("content-type") ?? "";
  const body: unknown = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const failure = body as ApiErrorBody;
    throw new ApiError(
      failure.error?.message ?? "Request failed",
      response.status,
      failure.error?.code ?? "request_failed",
    );
  }
  return body as T;
}

/**
 * Escapes text for interpolation into markup. `innerHTML` serialization only
 * escapes `& < >`, which is not sufficient inside a quoted attribute, so quotes
 * are escaped explicitly. Bookmark titles come from CSV cells, remote pages,
 * and model output, and previously could break out of an attribute.
 */
function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeTag(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function tagValues(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function friendlyDate(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function logout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    location.replace("/");
  }
}

el<HTMLButtonElement>("#logoutButton")?.addEventListener("click", logout);

let currentImportId: string | null = null;
let importRecoveryRequest: Promise<unknown> | null = null;

function setImportOverlay(visible: boolean, title?: string, message?: string, mode: "modal" | "progress" = "modal"): void {
  const overlay = el("#importOverlay");
  if (!overlay) return;
  overlay.hidden = !visible;
  overlay.classList.toggle("import-progress", visible && mode === "progress");
  document.body.classList.toggle("import-readonly", visible && mode === "progress");
  const card = overlay.querySelector(".busy-card");
  card.setAttribute("aria-modal", mode === "modal" ? "true" : "false");
  if (title) el("#importOverlayTitle").textContent = title;
  if (message !== undefined) el("#importOverlayMessage").textContent = message;
  const settingsProgress = el("#settingsImportProgress");
  const settingsForm = el<HTMLFormElement>("#importForm");
  if (settingsProgress && settingsForm) {
    const showProgress = visible && mode === "progress";
    settingsProgress.hidden = !showProgress;
    settingsForm.hidden = showProgress;
    if (title) el("#settingsImportTitle").textContent = title;
  }
}

function setImportProgress(status: ImportSession): void {
  const wrap = el("#importProgressWrap");
  const bar = el("#importProgressBar");
  const label = el("#importProgressLabel");
  const total = Number(status.valid_rows || 0);
  const processed = Number(status.processed_rows || 0);
  const percentage = total === 0 ? 100 : Math.min(100, Math.round(processed / total * 100));
  wrap.hidden = false;
  bar.style.width = percentage.toString() + "%";
  label.textContent = processed.toString() + " of " + total.toString() + " bookmarks processed" +
    (Number(status.duplicate_rows || 0) > 0 ? " · " + status.duplicate_rows.toString() + " duplicate rows skipped" : "") +
    (Number(status.invalid_rows || 0) > 0 ? " · " + status.invalid_rows.toString() + " invalid rows skipped" : "");
  const settingsBar = el("#settingsImportProgressBar");
  const settingsLabel = el("#settingsImportProgressLabel");
  if (settingsBar && settingsLabel) {
    settingsBar.style.width = percentage.toString() + "%";
    settingsLabel.textContent = label.textContent;
  }
}

async function waitForImport(importId: string): Promise<ImportSession> {
  let lastProcessed = -1;
  let lastProgressAt = Date.now();
  let lastRecoveryAt = 0;
  const retry = el<HTMLButtonElement>("#retryImportButton");
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
    el("#importOverlayMessage").textContent =
      "Requesting another safe import pass…";
    try {
      await requestRecovery();
      lastRecoveryAt = Date.now();
    } catch (error) {
      el("#importOverlayMessage").textContent = messageOf(error);
    } finally {
      retry.disabled = false;
    }
  };
  for (;;) {
    try {
      const result = await api<{ import: ImportSession }>("/api/imports/" + importId);
      const status = result.import;
      setImportProgress(status);
      const processed = Number(status.processed_rows || 0);
      if (processed !== lastProcessed) {
        lastProcessed = processed;
        lastProgressAt = Date.now();
        retry.hidden = true;
        el("#importOverlayTitle").textContent = "Import in progress";
        el("#importOverlayMessage").textContent =
          "You can browse your library while changes remain read-only.";
      }
      if (status.status === "committed") {
        el("#importOverlayTitle").textContent = "Import complete";
        el("#importOverlayMessage").textContent =
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
        el("#importOverlayTitle").textContent =
          "Import is taking longer than expected";
        el("#importOverlayMessage").textContent =
          "No progress was reported for 30 seconds. Resume asks the queue to continue unfinished rows; it does not restart or duplicate the import.";
        retry.hidden = false;
        await requestRecovery().catch(() => undefined);
      }
    } catch (error) {
      el("#importOverlayTitle").textContent = "Import status unavailable";
      el("#importOverlayMessage").textContent = messageOf(error);
      retry.hidden = false;
    }
    await delay(850);
  }
}

async function continueImport(importState: ImportSession): Promise<ImportSession> {
  currentImportId = importState.id;
  // A staged preview is unconfirmed work. It must never be committed on the
  // user's behalf just because they reloaded the page — PRD 10.4 requires an
  // explicit confirmation. Offer it as a dismissible, non-blocking dock.
  if (importState.status !== "committing") {
    const valid = Number(importState.valid_rows || 0);
    setImportOverlay(
      true,
      "Raindrop import ready",
      valid.toString() + (valid === 1 ? " bookmark is" : " bookmarks are") +
        " staged from " + (importState.file_name || "your CSV") +
        ". Nothing has been added to your library yet.",
      "progress",
    );
    el("#importProgressWrap").hidden = true;
    el("#importProgressLabel").textContent = "";
    el<HTMLButtonElement>("#cancelImportButton").hidden = false;
    const resume = el<HTMLButtonElement>("#retryImportButton");
    resume.hidden = false;
    resume.textContent = "Import these bookmarks";
    resume.onclick = async () => {
      resume.disabled = true;
      try {
        await api("/api/imports/" + importState.id + "/commit", {
          method: "POST",
          body: JSON.stringify({ duplicateDecisions: [] }),
        });
        resume.hidden = true;
        resume.textContent = "Resume import";
        setImportOverlay(true, "Import in progress", "You can keep using your library while this finishes.", "progress");
        await waitForImport(importState.id);
        await refreshLibraryViews();
      } catch (error) {
        el("#importOverlayMessage").textContent = messageOf(error);
      } finally {
        resume.disabled = false;
      }
    };
    return importState;
  }
  setImportOverlay(
    true,
    "Import in progress",
    "You can keep using your library while this finishes.",
    "progress",
  );
  return waitForImport(importState.id);
}

/** Refreshes the Settings inline import panel without a full page reload. */
async function refreshImportStatusPanels(importId: string): Promise<void> {
  try {
    const result = await api<{ import: ImportSession }>("/api/imports/" + importId);
    setImportProgress(result.import);
  } catch {
    // Transient polling failures are not user-actionable.
  }
}

/**
 * Uploads and commits without waiting for completion. The caller navigates
 * immediately; whichever page loads next picks the session up from
 * state().activeImport and renders the non-blocking progress dock.
 */
async function startImportInBackground(file: File | undefined, option: string): Promise<string> {
  if (!file) throw new Error("Choose a Raindrop CSV first.");
  const form = new FormData();
  form.set("file", file);
  form.set("option", option);
  const preview = await api<{ preview: ImportPreview }>("/api/imports/preview", { method: "POST", body: form });
  const importId = preview.preview.importId;
  await api("/api/imports/" + importId + "/commit", {
    method: "POST",
    body: JSON.stringify({ duplicateDecisions: [] }),
  });
  return importId;
}

async function commitImport(file: File | undefined, option: string, statusNode: HTMLElement | null): Promise<ImportSession> {
  if (!file) throw new Error("Choose a Raindrop CSV first.");
  setImportOverlay(true, "Checking your Raindrop export", "Looking for valid bookmarks and duplicates…");
  el<HTMLButtonElement>("#cancelImportButton").hidden = true;
  el("#importProgressWrap").hidden = true;
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
  el("#importOverlayTitle").textContent =
    "Ready to import";
  el("#importOverlayMessage").textContent =
    "Duplicate URLs inside the CSV will be skipped. Existing library bookmarks are kept unchanged.";
  el<HTMLButtonElement>("#cancelImportButton").hidden = true;
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

el<HTMLButtonElement>("#cancelImportButton")?.addEventListener("click", async () => {
  if (!currentImportId) return;
  try {
    await api("/api/imports/" + currentImportId + "/cancel", { method: "POST", body: "{}" });
    setImportOverlay(false);
    currentImportId = null;
  } catch (error) {
    el("#importOverlayMessage").textContent = messageOf(error);
  }
});

async function restoreActiveImport() {
  if (page === "login") return;
  try {
    const result = await api("/api/bootstrap");
    if (!result.state.activeImport) return;
    const status = await continueImport(result.state.activeImport);
    if (page === "setup" && status && status.status === "committed") {
      location.replace("/dashboard");
    }
  } catch {
    // Never let a leftover import block the page it is being restored onto.
    setImportOverlay(false);
    currentImportId = null;
  }
}

if (page === "setup") {
  void restoreActiveImport();
  const selectedTopics = new Set();
  const customTopics = new Set();
  const typedTopics = () => tagValues(el<HTMLInputElement>("#customTopic").value);
  const allSelectedTopics = () => {
    const topics = new Set([...selectedTopics, ...customTopics, ...typedTopics()]);
    return [...topics].slice(0, 20);
  };
  const renderCustomTopics = () => {
    const container = el("#customTopicTokens");
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
    all(".topic-chip").forEach(button => {
      if (button.dataset.customTopic) return;
      button.classList.toggle("selected", selectedTopics.has(button.dataset.topic));
      button.setAttribute("aria-pressed", selectedTopics.has(button.dataset.topic) ? "true" : "false");
    });
    const count = allSelectedTopics().length;
    el("#topicSelectionCount").textContent =
      count.toString() + " selected" +
      (count < 5 ? " · choose at least 5" : count >= 20 ? " · maximum 20" : " · ready");
    el<HTMLButtonElement>("#finishSetupButton").disabled = count < 5;
  };
  all(".topic-chip[data-topic]").forEach(button => button.addEventListener("click", () => {
    const topic = button.dataset.topic;
    if (selectedTopics.has(topic)) selectedTopics.delete(topic);
    else if (allSelectedTopics().length < 20) selectedTopics.add(topic);
    syncTopics();
  }));
  el<HTMLInputElement>("#customTopic").addEventListener("input", syncTopics);
  el<HTMLButtonElement>("#addCustomTopic").addEventListener("click", () => {
    const input = el<HTMLInputElement>("#customTopic");
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
  el<HTMLInputElement>("#customTopic").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      el<HTMLButtonElement>("#addCustomTopic").click();
    }
  });
  syncTopics();
  el<HTMLFormElement>("#setupForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = el("#setupStatus");
    try {
      status.className = "status";
      status.textContent = "Saving profile…";
      await api("/api/setup/complete", {
        method: "POST",
        body: JSON.stringify({
          relevantTags: allSelectedTopics(),
          careerContext: el<HTMLTextAreaElement>("#careerContext").value,
          aspirationContext: el<HTMLTextAreaElement>("#aspirationContext").value,
          personalInstructions: el<HTMLTextAreaElement>("#personalInstructions").value || null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
      });
      const file = el<HTMLInputElement>("#setupImportFile").files[0];
      if (file) {
        // Stage and start the import, then hand the user straight to the
        // dashboard. Progress is reported there by the non-blocking dock, so
        // setup never parks the user behind a modal waiting on a large CSV.
        const option = el<HTMLInputElement>("input[name=setupImportOption]:checked").value;
        status.textContent = "Starting your Raindrop import…";
        await startImportInBackground(file, option);
      }
      location.replace("/dashboard");
    } catch (error) {
      status.textContent = messageOf(error);
      status.className = "status error";
      setImportOverlay(false);
      currentImportId = null;
    }
  });
}


/* ---- Selection mode --------------------------------------------------- */
/* Bulk controls only exist inside an explicitly entered selection mode, so the
   default browsing view stays free of mutation controls. */
let selectionMode = false;
const selectedBookmarks = new Set<string>();
let lastSelectedId: string | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;

function inTrashView(): boolean {
  return currentFolder === "trash";
}

function renderBulkBar(): void {
  const bar = el("#bulkBar");
  const count = selectedBookmarks.size;
  bar.hidden = !selectionMode || count === 0;
  el("#bulkCount").textContent =
    count.toString() + " selected";
  el<HTMLButtonElement>("#bulkTrash").hidden = inTrashView();
  el<HTMLButtonElement>("#bulkFavorite").hidden = inTrashView();
  el<HTMLSelectElement>("#bulkFolder").hidden = inTrashView();
  el<HTMLButtonElement>("#bulkRestore").hidden = !inTrashView();
  el<HTMLButtonElement>("#bulkDelete").hidden = !inTrashView();
}

function syncCardSelection(): void {
  for (const card of all(".bookmark-card")) {
    const id = card.dataset.id ?? "";
    const chosen = selectedBookmarks.has(id);
    card.classList.toggle("selected", chosen);
    const box = card.querySelector<HTMLInputElement>(".card-select input");
    if (box !== null) box.checked = chosen;
  }
  renderBulkBar();
}

function setSelectionMode(active: boolean): void {
  selectionMode = active;
  document.body.classList.toggle("selecting", active);
  const button = el<HTMLButtonElement>("#selectModeButton");
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.textContent = active ? "Done" : "Select";
  if (!active) {
    selectedBookmarks.clear();
    lastSelectedId = null;
  }
  syncCardSelection();
}

function toggleSelected(id: string, extend: boolean): void {
  const ids = all(".bookmark-card").map(card => card.dataset.id ?? "");
  if (extend && lastSelectedId !== null) {
    const from = ids.indexOf(lastSelectedId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      for (const between of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        selectedBookmarks.add(between);
      }
      lastSelectedId = id;
      syncCardSelection();
      return;
    }
  }
  if (selectedBookmarks.has(id)) selectedBookmarks.delete(id);
  else selectedBookmarks.add(id);
  lastSelectedId = id;
  syncCardSelection();
}

function showToast(message: string, undo: (() => Promise<void>) | null): void {
  const toast = el("#toast");
  el("#toastMessage").textContent = message;
  const undoButton = el<HTMLButtonElement>("#toastUndo");
  undoButton.hidden = undo === null;
  toast.hidden = false;
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoButton.onclick = undo === null ? null : async () => {
    undoButton.disabled = true;
    try {
      await undo();
      await refreshLibraryViews();
    } finally {
      undoButton.disabled = false;
      toast.hidden = true;
    }
  };
  undoTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

/** Applies one request per selected bookmark and reports partial failure. */
async function bulkApply(
  action: (id: string) => Promise<unknown>,
): Promise<{ done: string[]; failed: number }> {
  const ids = [...selectedBookmarks];
  const done: string[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      await action(id);
      done.push(id);
    } catch {
      failed += 1;
    }
  }
  return { done, failed };
}

function bulkOutcome(verb: string, done: number, failed: number): string {
  return done.toString() + " bookmark" + (done === 1 ? "" : "s") + " " + verb +
    (failed > 0 ? " · " + failed.toString() + " failed" : "");
}

let bootstrap: BootstrapState | null = null;

/** Bootstrap is loaded before any view renders; reading it earlier is a bug. */
function state(): BootstrapState {
  if (bootstrap === null) throw new Error("Bootstrap state was read before it loaded");
  return bootstrap;
}
let currentFolder: string | null = null;
let selectedSearchTags = new Map<string, string>();
let currentBookmark: BookmarkDetail | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let nextBookmarkCursor: string | null = null;
let loadedBookmarkCount = 0;

async function loadBootstrap() {
  bootstrap = (await api<{ state: BootstrapState }>("/api/bootstrap")).state;
  const siteOptions = el<HTMLDataListElement>("#siteOptions");
  if (siteOptions) {
    siteOptions.innerHTML = (state().sites || []).map(site => '<option value="' + escapeHtml(site) + '"></option>').join("");
  }
  return bootstrap;
}

function folderOptions() {
  return state().folders
    .filter(folder => folder.slug !== "imports")
    .map(folder => '<option value="' + folder.id + '">' + escapeHtml(folder.name) + "</option>")
    .join("");
}

function renderFolders() {
  const nav = el("#folderNavigation");
  const visibleFolders = state().folders.filter(folder => folder.slug !== "imports");
  const allCount = state().folders.reduce(
    (total, folder) => total + Number(folder.bookmark_count || 0),
    0,
  );
  const items = [
    { id: null, name: "All Bookmarks", count: allCount },
    ...visibleFolders.map(folder => ({ ...folder, count: Number(folder.bookmark_count || 0) })),
    { id: "trash", name: "Trash", count: Number(state().trashCount || 0) },
  ];
  nav.innerHTML = items.map(item =>
    '<button type="button" data-folder="' + (item.id ?? "") + '" data-folder-name="' +
    escapeHtml(item.name) + '" class="' + (currentFolder === item.id ? "active" : "") + '">' +
    '<span class="folder-nav-label">' + escapeHtml(item.name) + '</span><span class="folder-count">' +
    Number(item.count).toString() + "</span></button>"
  ).join("");
  nav.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    currentFolder = button.dataset.folder || null;
    el("#libraryTitle").textContent = button.dataset.folderName;
    renderFolders();
    void loadBookmarks();
  }));
  el<HTMLSelectElement>("#bookmarkFolder").innerHTML = folderOptions();
  const bulkFolder = maybe<HTMLSelectElement>("#bulkFolder");
  if (bulkFolder !== null) {
    bulkFolder.innerHTML = '<option value="">Move to folder…</option>' + folderOptions();
  }
}

/**
 * Sidebar counts, tag registry, and the grid are one consistent view of the
 * library, so they are always refreshed together. Refreshing only some of them
 * is what previously let the sidebar drift out of sync with the results.
 */
async function refreshLibraryViews() {
  await loadBootstrap();
  renderFolders();
  renderTagNavigation();
  await loadBookmarks();
}

function bindTagNavigation(nav: HTMLElement): void {
  nav.querySelectorAll("[data-filter-tag]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.filterTag;
    if (selectedSearchTags.has(key)) selectedSearchTags.delete(key);
    else selectedSearchTags.set(key, button.dataset.filterDisplay);
    renderTagNavigation();
    renderSelectedTags();
    el<HTMLDialogElement>("#topicsDialog")?.close();
    void loadBookmarks();
  }));
}

/* ---- Topic management -------------------------------------------------
 * Deleting a topic is checkbox-based like bookmarks: the sidebar only
 * filters, and removal happens by selecting topics in the All topics dialog.
 * The old per-row × retired a topic library-wide from a single mis-click,
 * with no undo path. */
const selectedTopics = new Set<string>();

function tagNavigationMarkup(tags: TagSummary[], manage = false): string {
  if (tags.length === 0) {
    return '<p class="muted">Topics appear here as your library grows.</p>';
  }
  return tags.map(tag => {
    const filterButton =
      '<button type="button" class="tag-filter ' +
      (selectedSearchTags.has(tag.normalized_name) ? "active" : "") +
      '" data-filter-tag="' + escapeHtml(tag.normalized_name) + '" data-filter-display="' +
      escapeHtml(tag.display_name) + '"><span>#' + escapeHtml(tag.display_name) +
      '</span><span class="tag-count">' + Number(tag.usage_count).toString() +
      "</span></button>";
    if (!manage) return '<div class="tag-nav-row">' + filterButton + "</div>";
    return '<div class="tag-nav-row manage">' +
      '<label class="topic-select"><input type="checkbox" data-topic-id="' + escapeHtml(tag.id) +
      '" data-topic-name="' + escapeHtml(tag.display_name) +
      '" data-topic-count="' + Number(tag.usage_count).toString() +
      '"' + (selectedTopics.has(tag.id) ? " checked" : "") +
      ' aria-label="Select topic ' + escapeHtml(tag.display_name) + '"></label>' +
      filterButton + "</div>";
  }).join("");
}

function renderTopicSelection(): void {
  const bar = maybe("#topicBulkBar");
  if (bar === null) return;
  const count = selectedTopics.size;
  bar.hidden = count === 0;
  el("#topicBulkCount").textContent =
    count.toString() + " topic" + (count === 1 ? "" : "s") + " selected";
}

function bindTopicSelection(nav: HTMLElement): void {
  for (const box of [...nav.querySelectorAll<HTMLInputElement>("[data-topic-id]")]) {
    box.addEventListener("change", () => {
      const id = box.dataset.topicId ?? "";
      if (box.checked) selectedTopics.add(id);
      else selectedTopics.delete(id);
      renderTopicSelection();
    });
  }
  renderTopicSelection();
}

function renderTagNavigation() {
  const nav = el("#tagNavigation");
  const allNav = el("#allTagNavigation");
  const tags = state().tags
    .filter(tag => tag.status === "active")
    .sort((left, right) => Number(right.usage_count) - Number(left.usage_count) ||
      left.display_name.localeCompare(right.display_name));
  nav.innerHTML = tagNavigationMarkup(tags.slice(0, 8));
  bindTagNavigation(nav);
  if (allNav) {
    allNav.innerHTML = tagNavigationMarkup(tags, true);
    bindTopicSelection(allNav);
    bindTagNavigation(allNav);
  }
  el<HTMLButtonElement>("#viewAllTopicsButton").hidden = tags.length === 0;
}

function searchQuery(cursor: string | null = null): URLSearchParams {
  const params = new URLSearchParams({
    sort: el<HTMLSelectElement>("#sortSelect").value,
    direction: el<HTMLSelectElement>("#directionSelect").value,
    limit: "48",
  });
  const q = el<HTMLInputElement>("#searchInput").value.trim();
  const site = el<HTMLInputElement>("#siteInput").value.trim();
  const favorite = el<HTMLSelectElement>("#favoriteFilter").value;
  if (q) params.set("q", q.replace(/#[^\s#]*/g, "").trim());
  if (site) params.set("hostname", site);
  if (favorite) params.set("favorite", favorite);
  if (selectedSearchTags.size > 0) params.set("tags", [...selectedSearchTags.keys()].join(","));
  if (currentFolder === "trash") params.set("includeTrash", "true");
  else if (currentFolder) params.set("folder", currentFolder);
  const from = el<HTMLInputElement>("#dateFrom").value;
  const to = el<HTMLInputElement>("#dateTo").value;
  const field = el<HTMLSelectElement>("#dateField").value;
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

function previewImage(bookmark: Bookmark | BookmarkDetail, className = "thumbnail"): string {
  if (bookmark.thumbnail_id || bookmark.thumbnailAvailable) {
    const width = Number(bookmark.thumbnail_width) || 960;
    const height = Number(bookmark.thumbnail_height) || 540;
    return '<img class="' + className + '" src="/api/thumbnails/' + bookmark.id + '" width="' +
      width.toString() + '" height="' + height.toString() + '" loading="lazy" decoding="async" alt="">';
  }
  return '<div class="' + className + ' placeholder" aria-hidden="true"></div>';
}

function cardTags(bookmark: Bookmark): string {
  const values = (bookmark.tag_names || "").split(",").filter(Boolean).slice(0, 4);
  return values.map(tag => '<span class="chip">#' + escapeHtml(tag) + "</span>").join("");
}

function cardExcerpt(bookmark: Bookmark): string {
  const text = (bookmark.description || "").trim();
  if (!text) return "";
  return '<p class="card-excerpt">' + escapeHtml(text.length > 220 ? text.slice(0, 220) + "…" : text) + "</p>";
}

function bookmarkCards(bookmarks: Bookmark[]): string {
  return bookmarks.map(bookmark =>
    '<article class="bookmark-card" data-id="' + escapeHtml(bookmark.id) + '" tabindex="0" role="button" aria-label="View ' +
    escapeHtml(bookmark.title) + '">' +
    '<label class="card-select"><input type="checkbox" data-select-id="' + escapeHtml(bookmark.id) +
    '" aria-label="Select ' + escapeHtml(bookmark.title) + '"></label>' + previewImage(bookmark) +
    '<div class="bookmark-content"><div class="card-kicker"><span>' + escapeHtml(bookmark.folder_name) +
    '</span></div><h2>' + escapeHtml(bookmark.title) +
    '</h2>' + cardExcerpt(bookmark) + '<div class="chips">' + cardTags(bookmark) +
    '</div><div class="card-meta"><span class="site">' + escapeHtml(bookmark.hostname) +
    '</span><span>·</span><span>' + friendlyDate(bookmark.added_at) + "</span>" +
    (bookmark.favorite ? '<span class="fav" aria-label="Favorite">★</span>' : "") +
    "</div></div></article>"
  ).join("");
}

function setViewMode(mode: string): void {
  const grid = el("#bookmarkGrid");
  grid.classList.toggle("list-view", mode === "list");
  el<HTMLButtonElement>("#viewGridButton")?.classList.toggle("active", mode !== "list");
  el<HTMLButtonElement>("#viewListButton")?.classList.toggle("active", mode === "list");
  try { localStorage.setItem("lg-view-mode", mode); } catch {}
}

function bindBookmarkCards() {
  all(".bookmark-card:not([data-bound])").forEach(card => {
    card.dataset.bound = "true";
    const box = card.querySelector<HTMLInputElement>(".card-select input");
    if (box !== null) {
      box.addEventListener("click", event => {
        event.stopPropagation();
        if (!selectionMode) setSelectionMode(true);
        toggleSelected(box.dataset.selectId ?? "", (event as MouseEvent).shiftKey);
      });
    }
    card.addEventListener("click", event => {
      const id = card.dataset.id ?? "";
      if ((event.target as HTMLElement).closest(".card-select") !== null) return;
      if (selectionMode) {
        event.preventDefault();
        toggleSelected(id, event.shiftKey);
        return;
      }
      void openBookmark(id);
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (selectionMode) toggleSelected(card.dataset.id ?? "", event.shiftKey);
        else void openBookmark(card.dataset.id ?? "");
      }
    });
  });
}

/**
 * Placeholder cards shown while results load, so the grid animates into its
 * real shape instead of flashing a line of text. Heights vary to match the
 * masonry layout rather than implying every result is the same size.
 */
function skeletonCards(count: number): string {
  const heights = [168, 132, 210, 150, 186, 120];
  let markup = "";
  for (let index = 0; index < count; index += 1) {
    const height = heights[index % heights.length] ?? 160;
    markup +=
      '<div class="skeleton-card" aria-hidden="true">' +
      '<div class="skeleton-thumb" style="height:' + height.toString() + 'px"></div>' +
      '<div class="skeleton-body">' +
      '<div class="skeleton-line" style="width:82%"></div>' +
      '<div class="skeleton-line" style="width:64%"></div>' +
      '<div class="skeleton-line" style="width:44%"></div>' +
      "</div></div>";
  }
  return markup;
}

async function loadBookmarks(append = false): Promise<void> {
  const status = el("#libraryStatus");
  status.className = "status loading";
  status.innerHTML =
    '<span class="spinner"></span>' +
    (append ? "Loading more bookmarks…" : "Loading bookmarks…");
  const grid = el("#bookmarkGrid");
  if (append) grid.insertAdjacentHTML("beforeend", skeletonCards(4));
  else grid.innerHTML = skeletonCards(8);
  try {
    const cursor = append ? nextBookmarkCursor : null;
    const result = await api<BookmarkPageResponse>("/api/bookmarks?" + searchQuery(cursor).toString());
    for (const placeholder of all(".skeleton-card")) placeholder.remove();
    const cards = bookmarkCards(result.bookmarks);
    if (append) grid.insertAdjacentHTML("beforeend", cards);
    else grid.innerHTML = cards || '<div class="empty-state"><h2>Nothing here yet</h2><p>Try a different search or add a bookmark.</p></div>';
    loadedBookmarkCount = append
      ? loadedBookmarkCount + result.bookmarks.length
      : result.bookmarks.length;
    nextBookmarkCursor = result.nextCursor;
    el("#libraryCount").textContent =
      loadedBookmarkCount.toString() + " of " + Number(result.total).toString() + " bookmarks";
    el<HTMLButtonElement>("#loadMoreBookmarks").hidden = !nextBookmarkCursor;
    bindBookmarkCards();
    syncCardSelection();
    status.textContent = "";
  } catch (error) {
    for (const placeholder of all(".skeleton-card")) placeholder.remove();
    status.textContent = messageOf(error);
    status.className = "status error";
  }
}

function renderSelectedTags() {
  const container = el("#searchTagChips");
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
  const input = el<HTMLInputElement>("#searchInput");
  const menu = el("#tagSuggestions");
  const match = input.value.match(/(?:^|\s)#([^#\s]*)$/);
  if (!match) {
    menu.hidden = true;
    return;
  }
  const term = (match[1] || "").toLocaleLowerCase("en-US");
  const matches = state().tags
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
    input.value = input.value.replace(/(?:^|\s)#[^#\s]*$/, "").trim();
    menu.hidden = true;
    renderSelectedTags();
    void loadBookmarks();
    input.focus();
  }));
}

function activeFilterCount() {
  return [
    el<HTMLInputElement>("#siteInput").value,
    el<HTMLSelectElement>("#favoriteFilter").value,
    el<HTMLInputElement>("#dateFrom").value,
    el<HTMLInputElement>("#dateTo").value,
    el<HTMLSelectElement>("#sortSelect").value !== "added_at" ? "sort" : "",
    el<HTMLSelectElement>("#directionSelect").value !== "desc" ? "direction" : "",
  ].filter(Boolean).length;
}

function updateFilterCount() {
  const count = activeFilterCount();
  el("#filterCount").textContent = count === 0 ? "" : count.toString();
}

function detailTags(detail: BookmarkDetail): string {
  return (detail.tags || []).map(tag => '<span class="chip">#' + escapeHtml(tag.display_name) + "</span>").join("") ||
    '<span class="muted">No tags</span>';
}

function showDetail(detail: BookmarkDetail): void {
  currentBookmark = detail;
  el("#bookmarkDetailView").hidden = false;
  el<HTMLFormElement>("#bookmarkForm").hidden = true;
  el("#detailFolder").textContent = detail.folder_name + (detail.favorite ? " · Favorite" : "");
  el("#detailTitle").textContent = detail.title;
  el("#detailPreview").innerHTML = previewImage(detail, "thumbnail");
  el("#detailDescription").textContent = detail.description || "No description yet.";
  el("#detailNote").textContent = detail.note || "No note.";
  el("#detailTags").innerHTML = detailTags(detail);
  el("#detailSite").textContent = detail.hostname;
  el("#detailAdded").textContent = friendlyDate(detail.added_at);
  el("#detailCreated").textContent = friendlyDate(detail.source_created_at);
  el("#detailModified").textContent = friendlyDate(detail.modified_at);
  el("#detailRelationships").innerHTML = (detail.relatedBookmarks || []).map(related =>
    '<a href="' + escapeHtml(related.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(related.title) + "</a>"
  ).join("<br>") || '<span class="muted">None</span>';
  el<HTMLAnchorElement>("#detailExternalLink").href = detail.url;
  const inTrash = currentFolder === "trash";
  el<HTMLButtonElement>("#editDetailButton").hidden = inTrash;
  el<HTMLButtonElement>("#restoreDetailButton").hidden = !inTrash;
  el<HTMLButtonElement>("#deleteDetailButton").hidden = !inTrash;
}

async function openBookmark(id: string): Promise<void> {
  const detail = (await api<{ bookmark: BookmarkDetail }>("/api/bookmarks/" + id)).bookmark;
  showDetail(detail);
  el<HTMLDialogElement>("#bookmarkDialog").showModal();
}

function populateEditor(detail: BookmarkDetail | null): void {
  el("#bookmarkDetailView").hidden = true;
  el<HTMLFormElement>("#bookmarkForm").hidden = false;
  const related = detail?.relatedBookmarks?.[0] || null;
  const linkedInput = el<HTMLInputElement>("#bookmarkLinkedUrl");
  el<HTMLInputElement>("#bookmarkId").value = detail?.id || "";
  el<HTMLInputElement>("#bookmarkRevision").value = detail?.revision || "";
  el<HTMLInputElement>("#relatedBookmarkId").value = related?.id || "";
  el<HTMLInputElement>("#bookmarkUrl").value = detail?.url || "";
  linkedInput.value = related?.url || "";
  linkedInput.dataset.original = related?.url || "";
  el<HTMLInputElement>("#bookmarkTitle").value = detail?.title || "";
  el<HTMLTextAreaElement>("#bookmarkDescription").value = detail?.description || "";
  el<HTMLTextAreaElement>("#bookmarkNote").value = detail?.note || "";
  el<HTMLSelectElement>("#bookmarkFolder").innerHTML = folderOptions();
  el<HTMLSelectElement>("#bookmarkFolder").value = detail?.folder_id || "folder_unsorted";
  el<HTMLInputElement>("#bookmarkTags").value = (detail?.tags || []).map(tag => tag.display_name).join(", ");
  el<HTMLInputElement>("#bookmarkFavorite").checked = Boolean(detail?.favorite);
  el("#bookmarkDialogTitle").textContent = detail ? "Edit bookmark" : "Add bookmark";
  el<HTMLButtonElement>("#saveBookmarkButton").textContent = detail ? "Save changes" : "Add bookmark";
  el<HTMLButtonElement>("#trashBookmarkButton").hidden = !detail;
}

if (page === "dashboard") {
  let storedView = "grid";
  try { storedView = localStorage.getItem("lg-view-mode") || "grid"; } catch {}
  setViewMode(storedView);
  el<HTMLButtonElement>("#selectModeButton").addEventListener("click", () => {
    setSelectionMode(!selectionMode);
  });
  el<HTMLButtonElement>("#bulkCancel").addEventListener("click", () => setSelectionMode(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && selectionMode) setSelectionMode(false);
  });
  el<HTMLButtonElement>("#bulkSelectAll").addEventListener("click", () => {
    for (const card of all(".bookmark-card")) selectedBookmarks.add(card.dataset.id ?? "");
    syncCardSelection();
  });
  el<HTMLButtonElement>("#bulkTrash").addEventListener("click", async () => {
    const { done, failed } = await bulkApply(id =>
      api("/api/bookmarks/" + id + "/trash", { method: "POST", body: "{}" }));
    setSelectionMode(false);
    await refreshLibraryViews();
    // Trash is recoverable, so offer undo instead of a pre-confirmation.
    showToast(bulkOutcome("moved to Trash", done.length, failed), async () => {
      for (const id of done) {
        await api("/api/bookmarks/" + id + "/restore", { method: "POST", body: "{}" })
          .catch(() => undefined);
      }
    });
  });
  el<HTMLButtonElement>("#bulkRestore").addEventListener("click", async () => {
    const { done, failed } = await bulkApply(id =>
      api("/api/bookmarks/" + id + "/restore", { method: "POST", body: "{}" }));
    setSelectionMode(false);
    await refreshLibraryViews();
    showToast(bulkOutcome("restored", done.length, failed), null);
  });
  el<HTMLButtonElement>("#bulkDelete").addEventListener("click", async () => {
    // Permanent deletion has no undo, so it keeps an explicit confirmation.
    const count = selectedBookmarks.size;
    if (!confirm("Permanently delete " + count.toString() + " bookmark" +
      (count === 1 ? "" : "s") + "? This cannot be undone.")) return;
    const { done, failed } = await bulkApply(id =>
      api("/api/bookmarks/" + id + "/delete", { method: "DELETE" }));
    setSelectionMode(false);
    await refreshLibraryViews();
    showToast(bulkOutcome("permanently deleted", done.length, failed), null);
  });
  el<HTMLButtonElement>("#bulkFavorite").addEventListener("click", async () => {
    const { done, failed } = await bulkApply(async id => {
      const detail = (await api<{ bookmark: BookmarkDetail }>("/api/bookmarks/" + id)).bookmark;
      return api("/api/bookmarks/" + id, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: detail.revision, favorite: true }),
      });
    });
    setSelectionMode(false);
    await refreshLibraryViews();
    showToast(bulkOutcome("marked favorite", done.length, failed), null);
  });
  el<HTMLSelectElement>("#bulkFolder").addEventListener("change", async event => {
    const select = event.target as HTMLSelectElement;
    const folderId = select.value;
    if (!folderId) return;
    const { done, failed } = await bulkApply(async id => {
      const detail = (await api<{ bookmark: BookmarkDetail }>("/api/bookmarks/" + id)).bookmark;
      return api("/api/bookmarks/" + id, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: detail.revision, folderId }),
      });
    });
    select.value = "";
    setSelectionMode(false);
    await refreshLibraryViews();
    showToast(bulkOutcome("moved", done.length, failed), null);
  });
  el<HTMLButtonElement>("#viewGridButton")?.addEventListener("click", () => setViewMode("grid"));
  el<HTMLButtonElement>("#viewListButton")?.addEventListener("click", () => setViewMode("list"));
  (async () => {
    await refreshLibraryViews();
    if (state().activeImport) {
      // A failing import must never leave the library unusable, so the dock is
      // always torn down and the error surfaced inline.
      try {
        await continueImport(state().activeImport);
      } catch (error) {
        setImportOverlay(false);
        currentImportId = null;
        const status = el("#libraryStatus");
        status.textContent = "Raindrop import could not continue: " + messageOf(error);
        status.className = "status error";
      }
      await refreshLibraryViews();
    }
  })();

  el<HTMLInputElement>("#searchInput").addEventListener("input", () => {
    updateTagSuggestions();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadBookmarks(), 280);
  });
  el<HTMLInputElement>("#searchInput").addEventListener("keydown", event => {
    if (event.key === "Escape") el("#tagSuggestions").hidden = true;
    if (event.key === "Enter") {
      el("#tagSuggestions").hidden = true;
      void loadBookmarks();
    }
  });
  document.addEventListener("click", event => {
    if (!event.target.closest(".search-shell")) el("#tagSuggestions").hidden = true;
  });
  el<HTMLButtonElement>("#filterButton").addEventListener("click", () => el<HTMLDialogElement>("#filterDialog").showModal());
  el<HTMLFormElement>("#filterForm").addEventListener("submit", event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    updateFilterCount();
    el<HTMLDialogElement>("#filterDialog").close();
    void loadBookmarks();
  });
  el<HTMLButtonElement>("#clearFilters").addEventListener("click", () => {
    el<HTMLInputElement>("#siteInput").value = "";
    el<HTMLSelectElement>("#favoriteFilter").value = "";
    el<HTMLSelectElement>("#sortSelect").value = "added_at";
    el<HTMLSelectElement>("#directionSelect").value = "desc";
    el<HTMLSelectElement>("#dateField").value = "added_at";
    el<HTMLInputElement>("#dateFrom").value = "";
    el<HTMLInputElement>("#dateTo").value = "";
    updateFilterCount();
  });
  el<HTMLButtonElement>("#loadMoreBookmarks").addEventListener("click", () => {
    if (nextBookmarkCursor) void loadBookmarks(true);
  });
  el<HTMLButtonElement>("#viewAllTopicsButton").addEventListener("click", () => {
    renderTagNavigation();
    el<HTMLDialogElement>("#topicsDialog").showModal();
  });
  el<HTMLButtonElement>("#topicClearSelection").addEventListener("click", () => {
    selectedTopics.clear();
    renderTagNavigation();
  });
  el<HTMLButtonElement>("#topicDeleteSelected").addEventListener("click", async () => {
    const chosen = [...all<HTMLInputElement>("[data-topic-id]")]
      .filter(box => selectedTopics.has(box.dataset.topicId ?? ""));
    const affected = chosen.reduce((total, box) => total + Number(box.dataset.topicCount ?? 0), 0);
    const names = chosen.map(box => "#" + (box.dataset.topicName ?? "")).join(", ");
    // Retiring a topic is not recoverable from the UI, so it keeps an explicit
    // confirmation rather than an undo toast.
    if (!confirm(
      "Remove " + chosen.length.toString() + " topic" + (chosen.length === 1 ? "" : "s") +
      " (" + names + ") from " + affected.toString() + " bookmark" + (affected === 1 ? "" : "s") +
      "?\n\nThe bookmarks stay in your library, and the AI will stop using these topics."
    )) return;
    const button = el<HTMLButtonElement>("#topicDeleteSelected");
    button.disabled = true;
    let removed = 0;
    let failed = 0;
    for (const box of chosen) {
      try {
        await api("/api/tags/" + (box.dataset.topicId ?? ""), { method: "DELETE" });
        selectedSearchTags.delete((box.dataset.topicName ?? "").toLocaleLowerCase("en-US"));
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    selectedTopics.clear();
    button.disabled = false;
    await refreshLibraryViews();
    renderSelectedTags();
    showToast(
      removed.toString() + " topic" + (removed === 1 ? "" : "s") + " removed" +
        (failed > 0 ? " · " + failed.toString() + " failed" : ""),
      null,
    );
  });
  el<HTMLButtonElement>("#closeTopicsDialog").addEventListener("click", () => {
    el<HTMLDialogElement>("#topicsDialog").close();
  });
  el<HTMLButtonElement>("#addBookmarkButton").addEventListener("click", () => {
    el<HTMLFormElement>("#bookmarkForm").reset();
    currentBookmark = null;
    populateEditor(null);
    el<HTMLDialogElement>("#bookmarkDialog").showModal();
  });
  el<HTMLButtonElement>("#closeBookmarkDialog").addEventListener("click", () => el<HTMLDialogElement>("#bookmarkDialog").close());
  el<HTMLButtonElement>("#editDetailButton").addEventListener("click", () => populateEditor(currentBookmark));
  el<HTMLButtonElement>("#restoreDetailButton").addEventListener("click", async () => {
    await api("/api/bookmarks/" + currentBookmark.id + "/restore", { method: "POST", body: "{}" });
    el<HTMLDialogElement>("#bookmarkDialog").close();
    await loadBookmarks();
  });
  el<HTMLButtonElement>("#deleteDetailButton").addEventListener("click", async () => {
    if (!confirm("Permanently delete this bookmark? This cannot be undone.")) return;
    await api("/api/bookmarks/" + currentBookmark.id + "/delete", { method: "DELETE" });
    el<HTMLDialogElement>("#bookmarkDialog").close();
    await loadBookmarks();
  });
  el<HTMLButtonElement>("#trashBookmarkButton").addEventListener("click", async () => {
    const id = el<HTMLInputElement>("#bookmarkId").value;
    if (!id || !confirm("Move this bookmark to Trash?")) return;
    await api("/api/bookmarks/" + id + "/trash", { method: "POST", body: "{}" });
    el<HTMLDialogElement>("#bookmarkDialog").close();
    await loadBookmarks();
  });
  el<HTMLFormElement>("#bookmarkForm").addEventListener("submit", async event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const id = el<HTMLInputElement>("#bookmarkId").value;
    const oldRelatedId = el<HTMLInputElement>("#relatedBookmarkId").value;
    const linkedInput = el<HTMLInputElement>("#bookmarkLinkedUrl");
    const linkedUrl = linkedInput.value.trim();
    const relationshipChanged = linkedUrl !== (linkedInput.dataset.original || "");
    const payload = {
      url: el<HTMLInputElement>("#bookmarkUrl").value,
      title: el<HTMLInputElement>("#bookmarkTitle").value || null,
      description: el<HTMLTextAreaElement>("#bookmarkDescription").value || null,
      note: el<HTMLTextAreaElement>("#bookmarkNote").value || null,
      folderId: el<HTMLSelectElement>("#bookmarkFolder").value,
      tags: tagValues(el<HTMLInputElement>("#bookmarkTags").value),
      favorite: el<HTMLInputElement>("#bookmarkFavorite").checked,
    };
    if (id) {
      payload.expectedRevision = Number(el<HTMLInputElement>("#bookmarkRevision").value);
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
    el<HTMLDialogElement>("#bookmarkDialog").close();
    await loadBootstrap();
    renderFolders();
    renderTagNavigation();
    await loadBookmarks();
  });
}

function showSecret(selector: string, value: string): void {
  document.querySelector(selector).textContent = value;
}

function renderAutomationProgress() {
  const progress = state().automationProgress;
  const total = Number(progress.total || 0);
  const complete = Number(progress.complete || 0);
  const percent = total === 0 ? 100 : Math.round((complete / total) * 100);
  const outstanding = Number(progress.pending || 0) + Number(progress.processing || 0);
  let status = "AI sorting is up to date";
  if (state().ownerAiPaused) status = "AI sorting is paused";
  else if (state().provider.operational_status === "waiting") status = "AI provider needs attention";
  else if (outstanding > 0) status = "AI is sorting your library";
  else if (Number(progress.review || 0) + Number(progress.failed || 0) > 0) {
    status = "AI sorting finished with items needing attention";
  }
  el("#automationStatus").textContent = status;
  el("#automationProgressBar").style.width = percent.toString() + "%";
  el("#automationProgressLabel").textContent =
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
  el("#automationProgressStates").innerHTML = states.map(([label, count]) =>
    '<span class="progress-state">' + escapeHtml(label) + " " + Number(count).toString() + "</span>"
  ).join("");
}

async function loadSettings() {
  bootstrap = (await api<{ state: BootstrapState }>("/api/bootstrap")).state;
  el<HTMLSelectElement>("#providerName").value = state().provider.provider;
  el<HTMLInputElement>("#providerModel").value = state().provider.model;
  el("#providerStatus").textContent =
    state().provider.operational_status === "waiting"
      ? "AI needs attention: " + (state().provider.last_safe_error_code || "provider unavailable")
      : "AI provider is ready.";
  renderAutomationProgress();
  el<HTMLButtonElement>("#automationButton").textContent = state().ownerAiPaused ? "Resume AI" : "Pause AI";
  toggleKey();
  return bootstrap;
}

function toggleKey() {
  el("#providerKeyLabel").hidden = el<HTMLSelectElement>("#providerName").value === "workers-ai";
}

if (page === "settings") {
  initThemeControls();
  (async () => {
    await loadSettings();
    if (state().activeImport) {
      try {
        await continueImport(state().activeImport);
      } catch (error) {
        setImportOverlay(false);
        currentImportId = null;
        const status = el("#importStatus");
        status.textContent = "Raindrop import could not continue: " + messageOf(error);
        status.className = "status error";
      }
    }
  })();
  // Settings keeps polling during an import so its inline progress panel stays
  // live; it used to stop refreshing for exactly as long as an import ran.
  window.setInterval(() => {
    if (document.hidden) return;
    if (currentImportId === null) void loadSettings();
    else void refreshImportStatusPanels(currentImportId);
  }, 5000);
  el<HTMLSelectElement>("#providerName").addEventListener("change", toggleKey);
  el<HTMLFormElement>("#providerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = el("#providerStatus");
    status.textContent = "Testing provider…";
    try {
      const provider = el<HTMLSelectElement>("#providerName").value;
      const model = el<HTMLInputElement>("#providerModel").value;
      const credential = el<HTMLInputElement>("#providerKey").value || null;
      await api("/api/providers/test", { method: "POST", body: JSON.stringify({ provider, model, credential }) });
      await api("/api/providers/activate", { method: "POST", body: JSON.stringify({ provider, model }) });
      status.textContent = "Provider activated.";
      await loadSettings();
    } catch (error) {
      status.textContent = messageOf(error);
      status.className = "status error";
    }
  });
  el<HTMLButtonElement>("#automationButton").addEventListener("click", async () => {
    await api("/api/automation/pause", {
      method: "PUT",
      body: JSON.stringify({ paused: !state().ownerAiPaused }),
    });
    await loadSettings();
  });
  el<HTMLFormElement>("#importForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = el("#importStatus");
    try {
      await commitImport(
        el<HTMLInputElement>("#importFile").files[0],
        el<HTMLSelectElement>("#importOption").value,
        status,
      );
      status.textContent = "Import complete.";
      await loadSettings();
    } catch (error) {
      status.textContent = messageOf(error);
      status.className = "status error";
      setImportOverlay(false);
      currentImportId = null;
    }
  });
  el<HTMLButtonElement>("#pairExtension").addEventListener("click", async () => {
    const result = await api("/api/capture/credentials", {
      method: "POST",
      body: JSON.stringify({ kind: "extension", name: el<HTMLInputElement>("#extensionName").value }),
    });
    showSecret("#extensionCredential", "Deployment: " + location.origin + "\nToken: " + result.credential.token);
  });
  el<HTMLButtonElement>("#pairIos").addEventListener("click", async () => {
    const result = await api("/api/capture/credentials", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", name: "iOS Shortcut" }),
    });
    showSecret("#iosCredential", "Endpoint: " + location.origin + "/api/capture/ios\nToken: " + result.credential.token);
  });
  el<HTMLButtonElement>("#rotateMcp").addEventListener("click", async () => {
    const result = await api("/api/mcp/rotate", { method: "POST", body: "{}" });
    showSecret("#mcpCredential", result.url);
  });
  el<HTMLButtonElement>("#resetApplicationButton").addEventListener("click", async () => {
    const confirmation = prompt("This permanently deletes the complete Later Gator library and returns to setup. Type DELETE EVERYTHING to continue.");
    if (confirmation !== "DELETE EVERYTHING") return;
    const button = el<HTMLButtonElement>("#resetApplicationButton");
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
      el("#settingsStatus").textContent = messageOf(error);
      el("#settingsStatus").className = "status error";
    }
  });
}