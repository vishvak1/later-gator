"use strict";

import type {
  Bookmark,
  TagSummary,
  BookmarkDetail,
  BookmarkPageResponse,
  BootstrapState,
  ImportSession,
} from "./types";
import { extensionConnectionCode } from "./extension-connection";

/**
 * Non-null DOM lookups. A missing element is a programming error, not a
 * runtime condition to branch on, so these throw instead of returning null.
 * This is what removes ~230 unchecked `querySelector(...)!` hazards.
 */
function el<T = HTMLElement>(selector: string): T {
  const node = document.querySelector(selector) as T | null;
  if (node === null) throw new Error("Missing element: " + selector);
  return node;
}

function maybe<T = HTMLElement>(selector: string): T | null {
  return document.querySelector(selector) as T | null;
}

function all<T = HTMLElement>(selector: string): T[] {
  return [...document.querySelectorAll(selector)] as T[];
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

initThemeControls();

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
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return normalized === "ai" ? "artificial-intelligence" : normalized;
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

maybe<HTMLButtonElement>("#logoutButton")?.addEventListener("click", logout);

let currentImportId: string | null = null;

function setImportPanel(
  visible: boolean,
  title?: string,
  message?: string,
  busy = false,
): void {
  const panel = maybe("#importProgressPanel");
  if (panel !== null) {
    panel.hidden = !visible;
    panel.setAttribute("aria-busy", visible && busy ? "true" : "false");
    if (title !== undefined) el("#importPanelTitle").textContent = title;
    if (message !== undefined) el("#importPanelMessage").textContent = message;
  }
  const spinner = maybe<HTMLSpanElement>("#importSpinner");
  if (spinner !== null) spinner.hidden = !visible || !busy;
  const settingsForm = maybe<HTMLFormElement>("#importForm");
  if (settingsForm !== null) settingsForm.hidden = visible;
  if (!visible) {
    const wrap = maybe("#importProgressWrap");
    const bar = maybe("#importProgressBar");
    if (wrap !== null) wrap.hidden = true;
    if (bar !== null) {
      bar.style.width = "0%";
    }
  }
}

function setImportProgress(status: ImportSession): void {
  const wrap = maybe("#importProgressWrap");
  const bar = maybe("#importProgressBar");
  const label = maybe("#importProgressLabel");
  if (wrap === null || bar === null || label === null) return;
  const total = Number(status.total_rows || 0);
  const processed = Math.min(total, Number(status.processed_rows || 0));
  const percentage = total === 0 ? 100 : Math.round(processed / total * 100);
  const busy = status.status === "committing";
  wrap.hidden = false;
  bar.style.width = percentage.toString() + "%";
  wrap.setAttribute("aria-valuenow", percentage.toString());
  wrap.setAttribute("aria-valuetext", percentage.toString() + "% complete");
  const details = [
    Number(status.committed_rows || 0).toString() + " added",
    Number(status.duplicate_rows || 0) > 0
      ? status.duplicate_rows.toString() + " duplicates skipped"
      : "",
    Number(status.invalid_rows || 0) > 0
      ? status.invalid_rows.toString() + " invalid rows skipped"
      : "",
  ].filter(Boolean);
  label.textContent = processed.toString() + " of " + total.toString() +
    " rows processed · " + details.join(" · ");
  const spinner = maybe<HTMLSpanElement>("#importSpinner");
  if (spinner !== null) spinner.hidden = !busy;
  maybe("#importProgressPanel")?.setAttribute("aria-busy", busy ? "true" : "false");
}

async function waitForImport(importId: string): Promise<ImportSession> {
  let consecutiveStatusFailures = 0;
  for (;;) {
    try {
      const status = (await api<{ import: ImportSession }>("/api/imports/" + importId)).import;
      consecutiveStatusFailures = 0;
      setImportPanel(
        true,
        "Importing bookmarks",
        "New bookmarks are being added directly to Unsorted.",
        status.status === "committing",
      );
      setImportProgress(status);
      if (status.status === "committed") {
        setImportPanel(
          true,
          "Import complete",
          status.committed_rows.toString() + " bookmarks were added to Unsorted. " +
            status.duplicate_rows.toString() + " duplicates were skipped.",
        );
        try { sessionStorage.removeItem("lg-import-id"); } catch {
          // The completed D1 status is authoritative.
        }
        await delay(1500);
        setImportPanel(false);
        currentImportId = null;
        return status;
      }
      if (status.status === "cancelled" || status.status === "expired") {
        setImportPanel(
          true,
          "Import stopped",
          status.committed_rows.toString() +
            " bookmarks were added. Upload the same CSV again to add anything that remains.",
        );
        try { sessionStorage.removeItem("lg-import-id"); } catch {
          // The terminal D1 status is authoritative.
        }
        await delay(2500);
        setImportPanel(false);
        currentImportId = null;
        return status;
      }
    } catch {
      consecutiveStatusFailures += 1;
      if (consecutiveStatusFailures >= 3) {
        setImportPanel(
          true,
          "Importing bookmarks",
          "The progress check was interrupted. Later Gator is checking again automatically.",
          true,
        );
      }
    }
    await delay(500);
  }
}

async function beginRaindropImport(
  file: File | undefined,
  option: "reorganize" | "preserve",
  statusNode: HTMLElement | null,
): Promise<ImportSession> {
  if (!file) throw new Error("Choose a Raindrop CSV first.");
  setImportPanel(
    true,
    "Reading your Raindrop CSV",
    "Checking the URL column before adding bookmarks to Unsorted.",
    true,
  );
  const progressWrap = maybe("#importProgressWrap");
  if (progressWrap !== null) progressWrap.hidden = true;
  const form = new FormData();
  form.set("file", file);
  form.set("option", option);
  const started = await api<{ import: ImportSession }>("/api/imports", {
    method: "POST",
    body: form,
  });
  currentImportId = started.import.id;
  setImportPanel(
    true,
    "Importing bookmarks",
    "New bookmarks are being added directly to Unsorted.",
    true,
  );
  setImportProgress(started.import);
  if (statusNode !== null) statusNode.textContent = "Import started.";
  return started.import;
}

/** Refreshes the Settings inline import panel without a full page reload. */
async function refreshImportStatusPanels(importId: string): Promise<void> {
  try {
    const result = await api<{ import: ImportSession }>("/api/imports/" + importId);
    setImportProgress(result.import);
  } catch {
    // A later poll will recover a transient status request failure.
  }
}

if (page === "setup") {
  const selectedTopics = new Set<string>();
  const customTopics = new Set<string>();
  const typedTopics = () => tagValues(el<HTMLInputElement>("#customTopic").value);
  const allSelectedTopics = () => {
    const topics = new Set([...selectedTopics, ...customTopics, ...typedTopics()]);
    return [...topics];
  };
  const renderCustomTopics = () => {
    const container = el("#customTopicTokens");
    container.innerHTML = [...customTopics].map(topic =>
      '<button type="button" class="topic-chip selected" data-custom-topic="' +
      escapeHtml(topic) + '">' + escapeHtml(topic) + " ×</button>"
    ).join("");
    container.querySelectorAll<HTMLElement>("[data-custom-topic]").forEach(button => button.addEventListener("click", () => {
      const topic = button.dataset.customTopic;
      if (topic !== undefined) customTopics.delete(topic);
      renderCustomTopics();
      syncTopics();
    }));
  };
  const syncTopics = () => {
    all(".topic-chip").forEach(button => {
      if (button.dataset.customTopic) return;
      const topic = button.dataset.topic;
      button.classList.toggle("selected", topic !== undefined && selectedTopics.has(topic));
      button.setAttribute("aria-pressed", topic !== undefined && selectedTopics.has(topic) ? "true" : "false");
    });
    const count = allSelectedTopics().length;
    el("#topicSelectionCount").textContent =
      count.toString() + " selected" +
      (count < 5 ? " · choose at least 5" : " · ready");
    el<HTMLButtonElement>("#finishSetupButton").disabled = count < 5;
  };
  all(".topic-chip[data-topic]").forEach(button => button.addEventListener("click", () => {
    const topic = button.dataset.topic;
    if (topic === undefined) return;
    if (selectedTopics.has(topic)) selectedTopics.delete(topic);
    else selectedTopics.add(topic);
    syncTopics();
  }));
  el<HTMLInputElement>("#customTopic").addEventListener("input", syncTopics);
  el<HTMLButtonElement>("#addCustomTopic").addEventListener("click", () => {
    const input = el<HTMLInputElement>("#customTopic");
    const existingTopics = new Set([...selectedTopics, ...customTopics]);
    typedTopics()
      .filter(topic => !existingTopics.has(topic))
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
    let setupCompleted = false;
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
      setupCompleted = true;
      const file = el<HTMLInputElement>("#setupImportFile").files?.[0];
      if (file) {
        status.textContent = "Starting your Raindrop import…";
        const option = el<HTMLInputElement>('input[name="setupImportOption"]:checked').value;
        const started = await beginRaindropImport(
          file,
          option === "preserve" ? "preserve" : "reorganize",
          status,
        );
        try { sessionStorage.setItem("lg-import-id", started.id); } catch {
          // The dashboard can still discover an active import from D1.
        }
      }
      location.replace("/dashboard");
    } catch (error) {
      if (setupCompleted) {
        try { sessionStorage.setItem("lg-import-error", messageOf(error)); } catch {
          // Storage may be disabled; redirecting still keeps setup usable.
        }
        location.replace("/dashboard");
        return;
      }
      status.textContent = messageOf(error);
      status.className = "status error";
      setImportPanel(false);
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
const selectedSearchTags = new Map<string, string>();
const selectedBookmarkTags = new Map<string, string>();
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
    el("#libraryTitle").textContent = button.dataset.folderName ?? "Library";
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
  nav.querySelectorAll<HTMLElement>("[data-filter-tag]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.filterTag;
    const display = button.dataset.filterDisplay;
    if (key === undefined || display === undefined) return;
    if (selectedSearchTags.has(key)) selectedSearchTags.delete(key);
    else selectedSearchTags.set(key, display);
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

async function selectAllMatchingBookmarks(): Promise<void> {
  const button = el<HTMLButtonElement>("#bulkSelectAll");
  const status = el("#libraryStatus");
  const baseQuery = searchQuery();
  baseQuery.set("limit", "100");
  baseQuery.delete("cursor");
  const matchingIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Selecting…";
  try {
    do {
      const query = new URLSearchParams(baseQuery);
      if (cursor !== null) query.set("cursor", cursor);
      const result = await api<BookmarkPageResponse>("/api/bookmarks?" + query.toString());
      for (const bookmark of result.bookmarks) matchingIds.add(bookmark.id);
      cursor = result.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) throw new Error("The bookmark cursor repeated unexpectedly.");
        seenCursors.add(cursor);
      }
    } while (cursor !== null);

    selectedBookmarks.clear();
    for (const id of matchingIds) selectedBookmarks.add(id);
    syncCardSelection();
    status.textContent = "";
  } catch (error) {
    status.textContent = messageOf(error);
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Select all";
  }
}

function previewImage(bookmark: Bookmark | BookmarkDetail, className = "thumbnail"): string {
  if (bookmark.thumbnail_id || ("thumbnailAvailable" in bookmark && bookmark.thumbnailAvailable)) {
    const width = Number(bookmark.thumbnail_width) || 960;
    const height = Number(bookmark.thumbnail_height) || 540;
    const version = bookmark.thumbnail_id;
    if (!version) return '<div class="' + className + ' placeholder" aria-hidden="true"></div>';
    return '<img class="' + className + '" src="/api/thumbnails/' + bookmark.id + '/' + version + '" width="' +
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
  try { localStorage.setItem("lg-view-mode", mode); } catch {
    // View preference is optional when browser storage is unavailable.
  }
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
    const tag = button.dataset.searchTag;
    if (tag !== undefined) selectedSearchTags.delete(tag);
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
    const name = button.dataset.tagName;
    const display = button.dataset.tagDisplay;
    if (name === undefined || display === undefined) return;
    selectedSearchTags.set(name, display);
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

function renderBookmarkTags(): void {
  const container = el("#bookmarkSelectedTags");
  container.innerHTML = [...selectedBookmarkTags.entries()].map(([normalized, display]) =>
    '<button type="button" data-bookmark-tag="' + escapeHtml(normalized) + '">#' +
      escapeHtml(display) + " ×</button>"
  ).join("");
  container.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
    button.addEventListener("click", () => {
      const normalized = button.dataset.bookmarkTag;
      if (normalized !== undefined) selectedBookmarkTags.delete(normalized);
      renderBookmarkTags();
    });
  });
}

function addBookmarkTag(normalized: string, display = normalized): void {
  if (normalized === "" || selectedBookmarkTags.size >= 50) return;
  selectedBookmarkTags.set(normalized, display);
  el<HTMLInputElement>("#bookmarkTagInput").value = "";
  el("#bookmarkTagSuggestions").hidden = true;
  el<HTMLInputElement>("#bookmarkTagInput").setAttribute("aria-expanded", "false");
  el("#bookmarkTagHelp").textContent = "Type # to choose an existing tag or create a new one.";
  renderBookmarkTags();
}

function updateBookmarkTagSuggestions(): void {
  const input = el<HTMLInputElement>("#bookmarkTagInput");
  const menu = el("#bookmarkTagSuggestions");
  const raw = input.value.trim();
  if (!raw.startsWith("#")) {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    el("#bookmarkTagHelp").textContent = raw === ""
      ? "Type # to choose an existing tag or create a new one."
      : "Tags must start with #.";
    return;
  }
  const query = normalizeTag(raw);
  const matches = state().tags
    .filter(tag => tag.status === "active" && !selectedBookmarkTags.has(tag.normalized_name))
    .filter(tag => query === "" || tag.normalized_name.includes(query))
    .sort((left, right) => Number(right.usage_count) - Number(left.usage_count) ||
      left.display_name.localeCompare(right.display_name))
    .slice(0, 8);
  const exactExists = state().tags.some(tag =>
    tag.status === "active" && tag.normalized_name === query,
  );
  menu.innerHTML = matches.map(tag =>
    '<button type="button" role="option" data-tag-name="' + escapeHtml(tag.normalized_name) +
      '" data-tag-display="' + escapeHtml(tag.display_name) + '">#' +
      escapeHtml(tag.display_name) + "</button>"
  ).join("") + (query !== "" && !exactExists && !selectedBookmarkTags.has(query)
    ? '<button type="button" role="option" data-create-tag="' + escapeHtml(query) +
      '">Create #' + escapeHtml(query) + "</button>"
    : "");
  menu.hidden = menu.childElementCount === 0;
  input.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  el("#bookmarkTagHelp").textContent = query === ""
    ? "Keep typing after # to create a new tag."
    : "Choose a suggestion or press Enter to add.";
  menu.querySelectorAll<HTMLButtonElement>("[data-tag-name]").forEach(button => {
    button.addEventListener("click", () => {
      addBookmarkTag(button.dataset.tagName ?? "", button.dataset.tagDisplay);
      input.focus();
    });
  });
  menu.querySelectorAll<HTMLButtonElement>("[data-create-tag]").forEach(button => {
    button.addEventListener("click", () => {
      addBookmarkTag(button.dataset.createTag ?? "");
      input.focus();
    });
  });
}

function resetBookmarkTagEditor(tags: BookmarkDetail["tags"] = []): void {
  selectedBookmarkTags.clear();
  for (const tag of tags) selectedBookmarkTags.set(tag.normalized_name, tag.display_name);
  el<HTMLInputElement>("#bookmarkTagInput").value = "";
  el("#bookmarkTagSuggestions").hidden = true;
  renderBookmarkTags();
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
  el<HTMLInputElement>("#bookmarkRevision").value = String(detail?.revision ?? "");
  el<HTMLInputElement>("#relatedBookmarkId").value = related?.id || "";
  el<HTMLInputElement>("#bookmarkUrl").value = detail?.url || "";
  linkedInput.value = related?.url || "";
  linkedInput.dataset.original = related?.url || "";
  el<HTMLInputElement>("#bookmarkTitle").value = detail?.title || "";
  el<HTMLTextAreaElement>("#bookmarkDescription").value = detail?.description || "";
  el<HTMLTextAreaElement>("#bookmarkNote").value = detail?.note || "";
  el<HTMLSelectElement>("#bookmarkFolder").innerHTML = folderOptions();
  el<HTMLSelectElement>("#bookmarkFolder").value = detail?.folder_id || "folder_unsorted";
  resetBookmarkTagEditor(detail?.tags || []);
  el<HTMLInputElement>("#bookmarkFavorite").checked = Boolean(detail?.favorite);
  el("#bookmarkDialogTitle").textContent = detail ? "Edit bookmark" : "Add bookmark";
  el<HTMLButtonElement>("#saveBookmarkButton").textContent = detail ? "Save changes" : "Add bookmark";
  el<HTMLButtonElement>("#trashBookmarkButton").hidden = !detail;
}

if (page === "dashboard") {
  let storedView = "grid";
  try { storedView = localStorage.getItem("lg-view-mode") || "grid"; } catch {
    // Fall back to the grid when browser storage is unavailable.
  }
  setViewMode(storedView);
  el<HTMLButtonElement>("#bulkCancel").addEventListener("click", () => setSelectionMode(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && selectionMode) setSelectionMode(false);
  });
  el<HTMLButtonElement>("#bulkSelectAll").addEventListener("click", () => {
    void selectAllMatchingBookmarks();
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
  void (async () => {
    await refreshLibraryViews();
    try {
      const setupImportError = sessionStorage.getItem("lg-import-error");
      if (setupImportError !== null) {
        sessionStorage.removeItem("lg-import-error");
        setImportPanel(
          true,
          "Import did not start",
          setupImportError + " You can retry from Settings while using the rest of your library.",
        );
      }
    } catch {
      // A setup handoff message is optional and must not block the library.
    }
    let importToMonitor = state().activeImport;
    try {
      const handedOffId = sessionStorage.getItem("lg-import-id");
      if (handedOffId !== null) {
        importToMonitor = (await api<{ import: ImportSession }>(
          "/api/imports/" + handedOffId,
        )).import;
      }
    } catch {
      // The active D1 session remains discoverable without browser storage.
    }
    if (importToMonitor !== null) {
      currentImportId = importToMonitor.id;
      await waitForImport(importToMonitor.id);
      await refreshLibraryViews();
    }
  })();

  el<HTMLInputElement>("#searchInput").addEventListener("input", () => {
    updateTagSuggestions();
    if (searchTimer !== null) clearTimeout(searchTimer);
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
    if (!(event.target instanceof Element) || event.target.closest(".search-shell") === null) {
      el("#tagSuggestions").hidden = true;
    }
    if (!(event.target instanceof Element) || event.target.closest(".bookmark-tag-field") === null) {
      el("#bookmarkTagSuggestions").hidden = true;
      el<HTMLInputElement>("#bookmarkTagInput").setAttribute("aria-expanded", "false");
    }
  });
  el<HTMLButtonElement>("#filterButton").addEventListener("click", () => el<HTMLDialogElement>("#filterDialog").showModal());
  el<HTMLFormElement>("#filterForm").addEventListener("submit", event => {
    if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return;
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
  el<HTMLInputElement>("#bookmarkTagInput").addEventListener("input", updateBookmarkTagSuggestions);
  el<HTMLInputElement>("#bookmarkTagInput").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const normalized = normalizeTag(raw);
      if (raw.startsWith("#") && normalized !== "") {
        event.preventDefault();
        const existing = state().tags.find(tag =>
          tag.status === "active" && tag.normalized_name === normalized,
        );
        addBookmarkTag(normalized, existing?.display_name ?? normalized);
      }
    } else if (event.key === "Escape") {
      el("#bookmarkTagSuggestions").hidden = true;
    }
  });
  el<HTMLButtonElement>("#restoreDetailButton").addEventListener("click", async () => {
    if (currentBookmark === null) return;
    await api("/api/bookmarks/" + currentBookmark.id + "/restore", { method: "POST", body: "{}" });
    el<HTMLDialogElement>("#bookmarkDialog").close();
    await loadBookmarks();
  });
  el<HTMLButtonElement>("#deleteDetailButton").addEventListener("click", async () => {
    if (currentBookmark === null) return;
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
    if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return;
    event.preventDefault();
    const id = el<HTMLInputElement>("#bookmarkId").value;
    const oldRelatedId = el<HTMLInputElement>("#relatedBookmarkId").value;
    const linkedInput = el<HTMLInputElement>("#bookmarkLinkedUrl");
    const linkedUrl = linkedInput.value.trim();
    const relationshipChanged = linkedUrl !== (linkedInput.dataset.original || "");
    const payload: {
      url: string;
      title: string | null;
      description: string | null;
      note: string | null;
      folderId: string;
      tags: string[];
      favorite: boolean;
      expectedRevision?: number;
      linkedUrl?: string | null;
    } = {
      url: el<HTMLInputElement>("#bookmarkUrl").value,
      title: el<HTMLInputElement>("#bookmarkTitle").value || null,
      description: el<HTMLTextAreaElement>("#bookmarkDescription").value || null,
      note: el<HTMLTextAreaElement>("#bookmarkNote").value || null,
      folderId: el<HTMLSelectElement>("#bookmarkFolder").value,
      tags: [...selectedBookmarkTags.keys()],
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
  el(selector).textContent = value;
}

async function copySecret(
  valueSelector: string,
  statusSelector: string,
  successMessage: string,
): Promise<void> {
  const value = el(valueSelector).textContent?.trim() ?? "";
  if (value.length === 0) return;
  try {
    await navigator.clipboard.writeText(value);
    el(statusSelector).textContent = successMessage;
  } catch {
    el(statusSelector).textContent = "Copy failed. Select and copy the value manually.";
  }
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
  const states = ([
    ["Waiting", progress.pending],
    ["Processing", progress.processing],
    ["Provider wait", progress.waitingProvider],
    ["Paused", progress.pausedOwner],
    ["Review", progress.review],
    ["Failed", progress.failed],
  ] satisfies Array<[string, number]>).filter(([, count]) => Number(count || 0) > 0);
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
  const instructions = el<HTMLTextAreaElement>("#settingsPersonalInstructions");
  if (instructions.dataset.dirty !== "true") {
    instructions.value = state().personalInstructions ?? "";
  }
  toggleKey();
  return bootstrap;
}

function toggleKey() {
  el("#providerKeyLabel").hidden = el<HTMLSelectElement>("#providerName").value === "workers-ai";
}

if (page === "settings") {
  let settingsPageActive = true;
  const shouldReportSettingsError = (): boolean =>
    settingsPageActive && !document.hidden && document.body.dataset.page === "settings";
  void (async () => {
    try {
      await loadSettings();
      const activeImport = state().activeImport;
      if (activeImport !== null) {
        currentImportId = activeImport.id;
        await waitForImport(activeImport.id);
      }
    } catch (error) {
      if (!shouldReportSettingsError()) return;
      if (currentImportId !== null) {
        setImportPanel(false);
        currentImportId = null;
        const status = el("#importStatus");
        status.textContent = "Raindrop import could not continue: " + messageOf(error);
        status.className = "status error";
      } else {
        const status = el("#providerStatus");
        status.textContent = "Settings could not refresh: " + messageOf(error);
        status.className = "status error";
      }
    }
  })();
  // Settings keeps polling during an import so its inline progress panel stays
  // live; it used to stop refreshing for exactly as long as an import ran.
  const settingsRefreshInterval = window.setInterval(() => {
    if (document.hidden) return;
    const refresh = currentImportId === null
      ? loadSettings()
      : refreshImportStatusPanels(currentImportId);
    void refresh.catch((error: unknown) => {
      if (!shouldReportSettingsError()) return;
      const status = maybe("#providerStatus");
      if (status !== null) {
        status.textContent = "Settings could not refresh: " + messageOf(error);
        status.className = "status error";
      }
    });
  }, 5000);
  window.addEventListener("pagehide", () => {
    settingsPageActive = false;
    window.clearInterval(settingsRefreshInterval);
  }, { once: true });
  el<HTMLSelectElement>("#providerName").addEventListener("change", toggleKey);
  el<HTMLTextAreaElement>("#settingsPersonalInstructions").addEventListener("input", event => {
    (event.currentTarget as HTMLTextAreaElement).dataset.dirty = "true";
  });
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
  el<HTMLFormElement>("#personalInstructionsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = el("#personalInstructionsStatus");
    status.className = "status";
    status.textContent = "Saving instructions…";
    try {
      const value = el<HTMLTextAreaElement>("#settingsPersonalInstructions").value.trim();
      await api("/api/profile/personal-instructions", {
        method: "PUT",
        body: JSON.stringify({ personalInstructions: value || null }),
      });
      status.textContent = "Personal AI instructions saved.";
      if (bootstrap !== null) bootstrap.personalInstructions = value || null;
      delete el<HTMLTextAreaElement>("#settingsPersonalInstructions").dataset.dirty;
    } catch (error) {
      status.textContent = messageOf(error);
      status.className = "status error";
    }
  });
  el<HTMLFormElement>("#importForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = el("#importStatus");
    try {
      const started = await beginRaindropImport(
        el<HTMLInputElement>("#importFile").files?.[0],
        el<HTMLSelectElement>("#importOption").value === "preserve" ? "preserve" : "reorganize",
        status,
      );
      await waitForImport(started.id);
      status.textContent = "Import complete.";
      await loadSettings();
    } catch (error) {
      status.textContent = messageOf(error);
      status.className = "status error";
      setImportPanel(false);
      currentImportId = null;
    }
  });
  el<HTMLButtonElement>("#pairExtension").addEventListener("click", async () => {
    const result = await api<{ credential: { token: string } }>("/api/capture/credentials", {
      method: "POST",
      body: JSON.stringify({ kind: "extension", name: "Browser extension" }),
    });
    showSecret("#extensionCredential", extensionConnectionCode(location.origin, result.credential.token));
    el("#extensionCredentialPanel").hidden = false;
    el("#extensionCredentialStatus").textContent = "Connection code generated. Copy it before leaving this page.";
  });
  el<HTMLButtonElement>("#copyExtensionCredential").addEventListener("click", async () => {
    await copySecret("#extensionCredential", "#extensionCredentialStatus", "Connection code copied.");
  });
  for (const button of all<HTMLButtonElement>("[data-extension-guide]")) {
    button.addEventListener("click", () => {
      const browser = button.dataset.extensionGuide;
      el("#chromeExtensionGuide").hidden = browser !== "chrome";
      el("#firefoxExtensionGuide").hidden = browser !== "firefox";
      el<HTMLDialogElement>("#extensionGuideDialog").showModal();
    });
  }
  el<HTMLButtonElement>("#closeExtensionGuide").addEventListener("click", () => {
    el<HTMLDialogElement>("#extensionGuideDialog").close();
  });
  el<HTMLButtonElement>("#pairIos").addEventListener("click", async () => {
    const result = await api<{ credential: { token: string } }>("/api/capture/credentials", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", name: "iOS Shortcut" }),
    });
    showSecret("#iosEndpoint", location.origin + "/api/capture/ios");
    showSecret("#iosToken", result.credential.token);
    el("#iosCredentialPanel").hidden = false;
    el("#iosCredentialStatus").textContent = "Connection details generated. Copy them before leaving this page.";
  });
  el<HTMLButtonElement>("#copyIosEndpoint").addEventListener("click", async () => {
    await copySecret("#iosEndpoint", "#iosCredentialStatus", "Endpoint copied.");
  });
  el<HTMLButtonElement>("#copyIosToken").addEventListener("click", async () => {
    await copySecret("#iosToken", "#iosCredentialStatus", "Token copied.");
  });
  el<HTMLButtonElement>("#rotateMcp").addEventListener("click", async () => {
    const result = await api<{ url: string }>("/api/mcp/rotate", { method: "POST", body: "{}" });
    showSecret("#mcpCredential", result.url);
    el("#mcpCredentialPanel").hidden = false;
    el("#mcpCredentialStatus").textContent = "MCP URL generated. Copy it before leaving this page.";
  });
  el<HTMLButtonElement>("#copyMcpCredential").addEventListener("click", async () => {
    await copySecret("#mcpCredential", "#mcpCredentialStatus", "MCP URL copied.");
  });
  for (const button of all<HTMLButtonElement>("[data-connection-guide]")) {
    button.addEventListener("click", () => {
      const guide = button.dataset.connectionGuide;
      const isIos = guide === "ios";
      el("#connectionGuideKicker").textContent = isIos ? "iOS Share Sheet" : "Model Context Protocol";
      el("#connectionGuideTitle").textContent = isIos ? "Set up the iOS Shortcut" : "Connect an MCP client";
      el("#iosConnectionGuide").hidden = !isIos;
      el("#mcpConnectionGuide").hidden = isIos;
      el<HTMLDialogElement>("#connectionGuideDialog").showModal();
    });
  }
  el<HTMLButtonElement>("#closeConnectionGuide").addEventListener("click", () => {
    el<HTMLDialogElement>("#connectionGuideDialog").close();
  });
  el<HTMLButtonElement>("#resetApplicationButton").addEventListener("click", async () => {
    const confirmation = prompt("This permanently deletes the complete Later Gator library and returns to setup. Type DELETE EVERYTHING to continue.");
    if (confirmation !== "DELETE EVERYTHING") return;
    const button = el<HTMLButtonElement>("#resetApplicationButton");
    button.disabled = true;
    button.textContent = "Resetting…";
    try {
      const result = await api<{ redirectTo: string }>("/api/testing/reset", {
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
