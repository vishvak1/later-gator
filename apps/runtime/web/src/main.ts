"use strict";

import type {
  Bookmark,
  TagSummary,
  BookmarkDetail,
  BookmarkPageResponse,
  BootstrapState,
  ImportSession,
  XDestinationReview,
} from "./types";
// One source of truth with the server-rendered toolbar icons.
import { FOLDER_ICONS, ICONS } from "../../src/domain/icons";
import { HOW_TO_PANELS } from "../../src/domain/how-to";
import { isWorkersAiLimit, providerStatusMessage } from "../../src/domain/provider-status";

/**
 * The how-to overlay is shared by the dashboard (walk every panel) and Settings
 * (open one panel directly), so both call the same renderer.
 */
const HOW_TO_SEEN_KEY = "lg-how-to-seen";
/** Initializes how to for the dashboard UI. */
function initHowTo(): void {
  const dialog = maybe<HTMLDialogElement>("#howToDialog");
  if (dialog === null) return;
  let index = 0;
  /** Renders render for the dashboard UI. */
  const render = (): void => {
    const panel = HOW_TO_PANELS[index];
    if (panel === undefined) return;
    el("#howToKicker").textContent = panel.kicker;
    el("#howToTitle").textContent = panel.title;
    el("#howToBody").innerHTML = panel.body;
    el("#howToProgress").textContent =
      (index + 1).toString() + " of " + HOW_TO_PANELS.length.toString();
    el<HTMLButtonElement>("#howToPrev").disabled = index === 0;
    el<HTMLButtonElement>("#howToNext").disabled = index === HOW_TO_PANELS.length - 1;
    el("#howToBody").scrollTop = 0;
  };
  /** Opens the UI or connection managed by its enclosing component. */
  const open = (panelId?: string): void => {
    const found = HOW_TO_PANELS.findIndex(panel => panel.id === panelId);
    index = found === -1 ? 0 : found;
    render();
    if (!dialog.open) dialog.showModal();
  };
  el<HTMLButtonElement>("#howToPrev").addEventListener("click", () => {
    if (index > 0) { index -= 1; render(); }
  });
  el<HTMLButtonElement>("#howToNext").addEventListener("click", () => {
    if (index < HOW_TO_PANELS.length - 1) { index += 1; render(); }
  });
  el<HTMLButtonElement>("#closeHowTo").addEventListener("click", () => dialog.close());
  maybe<HTMLButtonElement>("#howToButton")?.addEventListener("click", () => open());
  // Settings opens a single panel from the connection card it belongs to.
  for (const button of all("[data-how-to]")) {
    button.addEventListener("click", () => open(button.dataset.howTo));
  }
  dialog.addEventListener("close", () => {
    try { localStorage.setItem(HOW_TO_SEEN_KEY, "1"); } catch { /* private mode */ }
  });
  if (document.body.dataset.page === "dashboard") {
    let seen = true;
    try { seen = localStorage.getItem(HOW_TO_SEEN_KEY) !== null; } catch { /* private mode */ }
    if (!seen) open();
  }
}

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

/** Returns an optional dashboard element when it exists. */
function maybe<T = HTMLElement>(selector: string): T | null {
  return document.querySelector(selector) as T | null;
}

/** Returns all dashboard elements matching a selector. */
function all<T = HTMLElement>(selector: string): T[] {
  return [...document.querySelectorAll(selector)] as T[];
}

/** Provider and network failures reach the UI as messages, never as `unknown`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/* ---- Theme ------------------------------------------------------------ */
type Theme = "light" | "dark" | "system";

/** Applies theme for the dashboard UI. */
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

/** Returns the active light or dark theme from the document root. */
function currentTheme(): Theme {
  const match = /(?:^|;\s*)lg_theme=(light|dark|system)(?:;|$)/u.exec(document.cookie);
  return (match?.[1] as Theme | undefined) ?? "system";
}

/** Initializes theme controls for the dashboard UI. */
function initThemeControls(): void {
  applyTheme(currentTheme());
  for (const button of all<HTMLButtonElement>("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      applyTheme((button.dataset.themeChoice ?? "system") as Theme);
    });
  }
}

const page = document.body.dataset.page;
/** Reads the dashboard CSRF token from its cookie. */
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

interface ThumbnailStorageSummary {
  byteSize: number;
  migrationId: string | null;
  migrationState: string | null;
  mode: "kv" | "r2" | "disabled";
  objectCount: number;
  safeErrorCode: string | null;
  status: "ready" | "paused" | "migrating";
}

interface ThumbnailStorageResponse {
  storage: ThumbnailStorageSummary;
}

interface CatalogModel {
  provider: "cloudflare" | "openai" | "anthropic";
  modelId: string;
  displayName: string;
  isDefault: boolean;
  deprecatedAfter: string | null;
  minimumRuntimeRelease: string;
}

interface ModelCatalog {
  publishedAt: string;
  revision: number;
  models: CatalogModel[];
}

interface StoragePlanCatalog {
  reviewedOn: string;
  disclaimer: string;
  plans: Array<{
    storageVariant: "kv" | "r2" | "disabled";
    title: string;
    summary: string;
    billingProfileMayBeRequired: boolean;
    informationalAllowances: string[];
    officialUrls: string[];
  }>;
}

interface PublicCatalogResponse {
  catalogs: {
    models: ModelCatalog | null;
    storagePlans: StoragePlanCatalog | null;
  };
}

interface ExtensionDevice {
  id: string;
  name: string;
  connectedAt: string;
  lastUsedAt: string | null;
}

let publicModelCatalog: ModelCatalog | null = null;

/** Sends an authenticated dashboard API request and returns its parsed JSON body. */
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

/** Normalizes tag for the dashboard UI. */
function normalizeTag(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return normalized === "ai" ? "artificial-intelligence" : normalized;
}

/** Parses and de-duplicates the comma-separated tag values from an input. */
function tagValues(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

/** Formats a stored timestamp for display in the current locale. */
function friendlyDate(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Returns a promise that settles after the requested delay. */
function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Ends the authenticated session and returns the browser to the login page. */
async function logout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    location.replace("/");
  }
}

maybe<HTMLButtonElement>("#logoutButton")?.addEventListener("click", logout);

let currentImportId: string | null = null;

/** Sets import panel for the dashboard UI. */
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

/** Sets import progress for the dashboard UI. */
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

/** Waits for for import for the dashboard UI. */
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

/** Starts raindrop import for the dashboard UI. */
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
  /** Reads normalized personalization topics from the setup topic field. */
  const typedTopics = () => tagValues(el<HTMLInputElement>("#customTopic").value);
  /** Combines typed and suggested setup topics without duplicates. */
  const allSelectedTopics = () => {
    const topics = new Set([...selectedTopics, ...customTopics, ...typedTopics()]);
    return [...topics];
  };
  /** Renders custom topics for the dashboard UI. */
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
  /** Synchronizes topics for the dashboard UI. */
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
    renderWizard();
  };

  /**
   * Three screens in one form rather than three routes, so a half-finished
   * setup is never a URL someone can land on directly or refresh into.
   */
  const LAST_STEP = 3;
  let step = 1;
  /** Reports whether the owner selected enough topics to continue setup. */
  const topicsSatisfied = () => allSelectedTopics().length >= 5;
  /** Renders wizard for the dashboard UI. */
  function renderWizard(): void {
    for (const screen of all("[data-step]")) {
      screen.hidden = screen.dataset.step !== String(step);
    }
    for (const marker of all("[data-step-marker]")) {
      const markerStep = Number(marker.dataset.stepMarker);
      marker.classList.toggle("done", markerStep < step);
      marker.classList.toggle("current", markerStep === step);
      if (markerStep === step) marker.setAttribute("aria-current", "step");
      else marker.removeAttribute("aria-current");
    }
    el<HTMLButtonElement>("#wizardBack").hidden = step === 1;
    const next = el<HTMLButtonElement>("#wizardNext");
    const finish = el<HTMLButtonElement>("#finishSetupButton");
    next.hidden = step === LAST_STEP;
    finish.hidden = step !== LAST_STEP;
    // Topics are the only gate; personalization and import are both optional.
    next.disabled = step === 1 && !topicsSatisfied();
    finish.disabled = !topicsSatisfied();
  }
  /** Activates one setup step and updates navigation, progress, and focus. */
  const goToStep = (nextStep: number): void => {
    step = Math.min(LAST_STEP, Math.max(1, nextStep));
    renderWizard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  el<HTMLButtonElement>("#wizardBack").addEventListener("click", () => goToStep(step - 1));
  el<HTMLButtonElement>("#wizardNext").addEventListener("click", () => goToStep(step + 1));
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

/** Reports whether the current folder filter represents Trash. */
function inTrashView(): boolean {
  return currentFolder === "trash";
}

/** Renders bulk bar for the dashboard UI. */
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

/** Synchronizes card selection for the dashboard UI. */
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

/** Sets selection mode for the dashboard UI. */
function setSelectionMode(active: boolean): void {
  selectionMode = active;
  document.body.classList.toggle("selecting", active);
  if (!active) {
    selectedBookmarks.clear();
    lastSelectedId = null;
  }
  syncCardSelection();
}

/** Toggles selected for the dashboard UI. */
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

/** Shows toast for the dashboard UI. */
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

/** Summarizes success and failure counts after a bulk bookmark mutation. */
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
let favoritesOnly = false;
let notesOnly = false;
let nextBookmarkCursor: string | null = null;
let loadedBookmarkCount = 0;

/** Loads bootstrap for the dashboard UI. */
async function loadBootstrap() {
  bootstrap = (await api<{ state: BootstrapState }>("/api/bootstrap")).state;
  const siteOptions = el<HTMLDataListElement>("#siteOptions");
  if (siteOptions) {
    siteOptions.innerHTML = (state().sites || []).map(site => '<option value="' + escapeHtml(site) + '"></option>').join("");
  }
  return bootstrap;
}

/** Renders selectable permanent folders while excluding system-only choices. */
function folderOptions() {
  return state().folders
    .filter(folder => folder.slug !== "imports")
    .map(folder => '<option value="' + folder.id + '">' + escapeHtml(folder.name) + "</option>")
    .join("");
}

/* ---- Workers AI limit surfacing ---------------------------------------
 * The pause is invisible otherwise: sorting simply stops, and the only hint is
 * a count that never moves. The indicator says it permanently, the notice says
 * it once per occurrence, and the mute is remembered per error code so muting
 * a spent allowance does not also mute a future, different fault.
 */
const AI_NOTICE_MUTE_KEY = "lg-ai-notice-muted";

/** Detects whether provider status indicates the current AI allowance is exhausted. */
function aiLimitReached(): boolean {
  const provider = state().provider;
  return (
    provider.operational_status === "waiting" &&
    isWorkersAiLimit(provider.last_safe_error_code)
  );
}

/** Reads whether the owner dismissed the current AI allowance notice. */
function aiNoticeMuted(code: string): boolean {
  try {
    return localStorage.getItem(AI_NOTICE_MUTE_KEY) === code;
  } catch {
    return false;
  }
}

/** Renders ai alert for the dashboard UI. */
function renderAiAlert(): void {
  const wrap = maybe("#aiAlertWrap");
  if (wrap === null) return;
  const reached = aiLimitReached();
  wrap.hidden = !reached;
  if (!reached) return;
  const message = providerStatusMessage(
    state().provider.last_safe_error_code,
    "AI sorting needs attention.",
  );
  el("#aiAlertPopover").textContent = message;
  el<HTMLButtonElement>("#aiAlert").setAttribute("aria-label", message);
}

/** Shows ai notice for the dashboard UI. */
function showAiNotice(): void {
  const notice = maybe("#aiNotice");
  if (notice === null || !aiLimitReached()) return;
  const code = state().provider.last_safe_error_code ?? "";
  if (aiNoticeMuted(code)) return;
  el("#aiNoticeMessage").textContent = providerStatusMessage(
    code,
    "AI sorting needs attention.",
  );
  el<HTMLInputElement>("#aiNoticeMute").checked = false;
  notice.hidden = false;
}

/** Initializes ai notice for the dashboard UI. */
function initAiNotice(): void {
  const notice = maybe("#aiNotice");
  if (notice === null) return;
  /** Hides the AI allowance notice and remembers that choice locally. */
  const dismiss = (): void => {
    if (el<HTMLInputElement>("#aiNoticeMute").checked) {
      try {
        localStorage.setItem(AI_NOTICE_MUTE_KEY, state().provider.last_safe_error_code ?? "");
      } catch {
        // Muting is a convenience; the indicator still reports the state.
      }
    }
    notice.hidden = true;
  };
  el<HTMLButtonElement>("#aiNoticeClose").addEventListener("click", dismiss);
}

/** The mascot only waves where AI actually works: Unsorted. */
function syncUnsortedMascot(): void {
  const mascot = maybe("#unsortedMascot");
  if (mascot !== null) mascot.hidden = currentFolder !== "folder_unsorted";
}

/** Renders folders for the dashboard UI. */
function renderFolders() {
  const nav = el("#folderNavigation");
  const visibleFolders = state().folders.filter(folder => folder.slug !== "imports");
  const allCount = state().folders.reduce(
    (total, folder) => total + Number(folder.bookmark_count || 0),
    0,
  );
  const items = [
    { id: null, slug: "all", name: "All Bookmarks", count: allCount },
    ...visibleFolders.map(folder => ({ ...folder, count: Number(folder.bookmark_count || 0) })),
    { id: "trash", slug: "trash", name: "Trash", count: Number(state().trashCount || 0) },
  ];
  nav.innerHTML = items.map(item =>
    '<button type="button" data-folder="' + (item.id ?? "") + '" data-folder-name="' +
    escapeHtml(item.name) + '" class="' + (currentFolder === item.id ? "active" : "") + '">' +
    '<span class="folder-icon" aria-hidden="true">' + (FOLDER_ICONS[String(item.slug)] ?? "") + "</span>" +
    '<span class="folder-nav-label">' + escapeHtml(item.name) + '</span><span class="folder-count">' +
    Number(item.count).toString() + "</span></button>"
  ).join("");
  nav.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    currentFolder = button.dataset.folder || null;
    el("#libraryTitle").textContent = button.dataset.folderName ?? "Library";
    syncUnsortedMascot();
    renderFolders();
    void loadBookmarks();
  }));
  syncUnsortedMascot();
  el<HTMLSelectElement>("#bookmarkFolder").innerHTML = folderOptions();
  const bulkFolder = maybe<HTMLSelectElement>("#bulkFolder");
  if (bulkFolder !== null) {
    bulkFolder.innerHTML = '<option value="">Move to folder…</option>' + folderOptions();
  }
}

/**
 * A fingerprint of everything the sidebar and grid are derived from. Comparing
 * it is what makes a repaint a consequence of changed state rather than of a
 * clock: identical state repaints nothing.
 */
let lastLibraryFingerprint = "";

/** Creates a stable summary key used to skip redundant library rerenders. */
function libraryFingerprint(): string {
  const current = state();
  return JSON.stringify([
    current.folders.map(folder => [folder.id, Number(folder.bookmark_count || 0)]),
    Number(current.trashCount || 0),
    current.tags
      .filter(tag => tag.status === "active")
      .map(tag => [tag.id, Number(tag.usage_count)]),
    current.automationProgress,
    current.activeImport?.id ?? null,
    // A provider going into or out of its limit is a state change the dashboard
    // has to repaint for, even when no bookmark moved.
    current.provider.operational_status,
    current.provider.last_safe_error_code,
  ]);
}

/**
 * Sidebar counts, tag registry, and the grid are one consistent view of the
 * library, so they are always refreshed together. Refreshing only some of them
 * is what previously let the sidebar drift out of sync with the results.
 */
async function refreshLibraryViews() {
  await loadBootstrap();
  lastLibraryFingerprint = libraryFingerprint();
  renderFolders();
  renderTagNavigation();
  renderAiAlert();
  await loadBookmarks();
}

/** Binds tag navigation for the dashboard UI. */
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

/** Renders tag filter navigation with counts and active-state accessibility. */
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

/** Renders topic selection for the dashboard UI. */
function renderTopicSelection(): void {
  const bar = maybe("#topicBulkBar");
  if (bar === null) return;
  const count = selectedTopics.size;
  bar.hidden = count === 0;
  el("#topicBulkCount").textContent =
    count.toString() + " topic" + (count === 1 ? "" : "s") + " selected";
}

/** Binds topic selection for the dashboard UI. */
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

/** Renders tag navigation for the dashboard UI. */
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

/** Builds the encoded bookmark-list query from search, folder, and tag filters. */
function searchQuery(cursor: string | null = null): URLSearchParams {
  const params = new URLSearchParams({
    sort: el<HTMLSelectElement>("#sortSelect").value,
    direction: el<HTMLSelectElement>("#directionSelect").value,
    limit: "48",
  });
  const q = el<HTMLInputElement>("#searchInput").value.trim();
  const site = el<HTMLInputElement>("#siteInput").value.trim();
  // The toolbar heart is a shortcut for the same filter the dialog exposes, so
  // whichever one the owner touched last is the one that applies.
  const favorite = favoritesOnly
    ? "true"
    : el<HTMLSelectElement>("#favoriteFilter").value;
  if (q) params.set("q", q.replace(/#[^\s#]*/g, "").trim());
  if (site) params.set("hostname", site);
  if (favorite) params.set("favorite", favorite);
  if (notesOnly) params.set("hasNote", "true");
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

/** Selects all matching bookmarks for the dashboard UI. */
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

/**
 * Folders whose illustration exists in web/img/folders. Anything not listed —
 * Unsorted, Need for Review, Trash — falls back to the mark on a themed panel,
 * which is also what a bookmark still being processed gets.
 */
const ILLUSTRATED_FOLDERS = new Set([
  "social-posts",
  "articles",
  "videos-talks",
  "code",
  "docs-reference",
  "papers",
  "websites-apps",
]);

/** Resolves a folder ID to the slug used in routes and filter state. */
function folderSlugOf(bookmark: Bookmark | BookmarkDetail): string {
  if (bootstrap === null) return "";
  return state().folders.find(folder => folder.id === bookmark.folder_id)?.slug ?? "";
}

/**
 * A bookmark with no stored cover shows its folder's artwork rather than a
 * spinner that never resolves: for many bookmarks there will never be a cover
 * to load, so a perpetual loading state was describing a wait that was not
 * happening. The slug drives a CSS rule rather than an inline style, because
 * the page's content-security-policy rejects style attributes.
 */
function placeholderPreview(
  bookmark: Bookmark | BookmarkDetail,
  className: string,
): string {
  const slug = folderSlugOf(bookmark);
  const illustrated = ILLUSTRATED_FOLDERS.has(slug);
  return '<div class="' + className + ' placeholder' + (illustrated ? " illustrated" : " marked") +
    '"' + (illustrated ? ' data-folder="' + escapeHtml(slug) + '"' : "") +
    ' aria-hidden="true"></div>';
}

/** Renders a dimensioned thumbnail image or the deterministic placeholder. */
function previewImage(bookmark: Bookmark | BookmarkDetail, className = "thumbnail"): string {
  if (bookmark.thumbnail_id || ("thumbnailAvailable" in bookmark && bookmark.thumbnailAvailable)) {
    const width = Number(bookmark.thumbnail_width) || 960;
    const height = Number(bookmark.thumbnail_height) || 540;
    const thumbnailId = bookmark.thumbnail_id;
    if (!thumbnailId) return placeholderPreview(bookmark, className);
    return '<img class="' + className + '" src="/api/thumbnails/' + bookmark.id + '/' + thumbnailId + '" width="' +
      width.toString() + '" height="' + height.toString() + '" loading="lazy" decoding="async" alt="">';
  }
  return placeholderPreview(bookmark, className);
}

/** Renders at most four bookmark tags as compact chips. */
function cardTags(bookmark: Bookmark): string {
  const values = (bookmark.tag_names || "").split(",").filter(Boolean).slice(0, 4);
  return values.map(tag => '<span class="chip">#' + escapeHtml(tag) + "</span>").join("");
}

/** Selects and safely truncates the most useful bookmark summary text. */
function cardExcerpt(bookmark: Bookmark): string {
  const text = (bookmark.description || "").trim();
  if (!text) return "";
  return '<p class="card-excerpt">' + escapeHtml(text.length > 220 ? text.slice(0, 220) + "…" : text) + "</p>";
}

/** Converts durable safe review codes into owner-facing failure categories. */
function reviewReasonLabel(code: string | null): string {
  const labels: Record<string, string> = {
    content_unavailable: "Retrieval failure",
    ai_insufficient_evidence: "Insufficient evidence",
    invalid_model_result: "Invalid AI response",
    x_destination_already_saved: "Destination already saved",
  };
  return code === null ? "Needs review" : labels[code] ?? "Needs review";
}

/** Renders the X decision button only for a duplicate-destination review. */
function xReviewButton(bookmark: Bookmark): string {
  if (bookmark.review_reason !== "x_destination_already_saved") return "";
  return '<button type="button" class="x-review-button" data-x-review-id="' +
    escapeHtml(bookmark.id) + '" title="Review saved X destination" aria-label="Review saved X destination">' +
    ICONS.x + "</button>";
}

/** Adds the durable review category directly to cards in Need for Review. */
function reviewBadge(bookmark: Bookmark): string {
  return bookmark.review_reason === null
    ? ""
    : '<span class="review-category">' + escapeHtml(reviewReasonLabel(bookmark.review_reason)) + "</span>";
}

/** Renders the current bookmark result set with selection and mutation controls. */
function bookmarkCards(bookmarks: Bookmark[]): string {
  return bookmarks.map(bookmark =>
    // A card the AI is working on right now gets a travelling corner glow.
    '<article class="bookmark-card' + (bookmark.ai_state === "processing" ? " processing" : "") +
    '" data-id="' + escapeHtml(bookmark.id) + '" tabindex="0" role="button" aria-label="View ' +
    escapeHtml(bookmark.title) + (bookmark.ai_state === "processing" ? ", being organized" : "") + '">' +
    '<label class="card-select"><input type="checkbox" data-select-id="' + escapeHtml(bookmark.id) +
    '" aria-label="Select ' + escapeHtml(bookmark.title) + '"></label>' + previewImage(bookmark) +
    '<div class="bookmark-content"><div class="card-kicker"><span>' + escapeHtml(bookmark.folder_name) +
    reviewBadge(bookmark) + '</span>' + xReviewButton(bookmark) + '</div><h2>' + escapeHtml(bookmark.title) +
    '</h2>' + cardExcerpt(bookmark) + '<div class="chips">' + cardTags(bookmark) +
    '</div><div class="card-meta"><span class="site">' + escapeHtml(bookmark.hostname) +
    '</span><span>·</span><span>' + friendlyDate(bookmark.added_at) + "</span>" +
    favoriteButton(bookmark) +
    "</div></div></article>"
  ).join("");
}

/**
 * Favouriting is one click on the card. It used to be a star that only reported
 * state, so the only way to favourite something was to open it and edit it.
 */
function favoriteButton(bookmark: Bookmark): string {
  const on = Boolean(bookmark.favorite);
  return '<button type="button" class="card-fav' + (on ? " on" : "") +
    '" data-favorite-id="' + escapeHtml(bookmark.id) +
    '" aria-pressed="' + (on ? "true" : "false") +
    '" title="' + (on ? "Remove from favorites" : "Add to favorites") +
    '" aria-label="' + (on ? "Remove from favorites" : "Add to favorites") + '">' +
    ICONS.heart + "</button>";
}

/**
 * Optimistic: the heart fills on click and reverts if the write fails, because
 * waiting for a round trip to acknowledge a toggle feels broken.
 */
async function toggleFavorite(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.favoriteId;
  if (id === undefined || button.disabled) return;
  const next = button.getAttribute("aria-pressed") !== "true";
  /** Updates the favorite control to reflect its current state. */
  const paint = (on: boolean): void => {
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
    const label = on ? "Remove from favorites" : "Add to favorites";
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  button.disabled = true;
  paint(next);
  try {
    const detail = (await api<{ bookmark: BookmarkDetail }>("/api/bookmarks/" + id)).bookmark;
    await api("/api/bookmarks/" + id, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: detail.revision, favorite: next }),
    });
    // Only the sidebar counts can have moved, so the grid is left alone: a
    // rebuild here would drop the card out from under the pointer.
    await loadBootstrap();
    lastLibraryFingerprint = libraryFingerprint();
  } catch (error) {
    paint(!next);
    showToast(messageOf(error), null);
  } finally {
    button.disabled = false;
  }
}

/** Sets view mode for the dashboard UI. */
function setViewMode(mode: string): void {
  const grid = el("#bookmarkGrid");
  grid.classList.toggle("list-view", mode === "list");
  el<HTMLButtonElement>("#viewGridButton")?.classList.toggle("active", mode !== "list");
  el<HTMLButtonElement>("#viewListButton")?.classList.toggle("active", mode === "list");
  try { localStorage.setItem("lg-view-mode", mode); } catch {
    // View preference is optional when browser storage is unavailable.
  }
}

/** Binds bookmark cards for the dashboard UI. */
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
    const favorite = card.querySelector<HTMLButtonElement>(".card-fav");
    if (favorite !== null) {
      favorite.addEventListener("click", event => {
        // The whole card opens the bookmark, so the heart has to keep its click.
        event.stopPropagation();
        event.preventDefault();
        void toggleFavorite(favorite);
      });
    }
    const xReview = card.querySelector<HTMLButtonElement>(".x-review-button");
    if (xReview !== null) {
      xReview.addEventListener("click", event => {
        event.stopPropagation();
        void openXDestinationReview(xReview.dataset.xReviewId ?? "");
      });
    }
    card.addEventListener("click", event => {
      const id = card.dataset.id ?? "";
      if ((event.target as HTMLElement).closest(".card-select") !== null) return;
      if ((event.target as HTMLElement).closest(".card-fav") !== null) return;
      if ((event.target as HTMLElement).closest(".x-review-button") !== null) return;
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

/**
 * `quiet` renders without the skeleton flash and without the "Loading
 * bookmarks…" line. It is for a repaint the owner did not ask for — returning
 * to the tab — where tearing the grid down and rebuilding it looks like the page
 * reloading itself for no reason.
 */
async function loadBookmarks(append = false, quiet = false): Promise<void> {
  const status = el("#libraryStatus");
  const grid = el("#bookmarkGrid");
  if (!quiet) {
    status.className = "status loading";
    status.innerHTML =
      '<span class="spinner"></span>' +
      (append ? "Loading more bookmarks…" : "Loading bookmarks…");
    if (append) grid.insertAdjacentHTML("beforeend", skeletonCards(4));
    else grid.innerHTML = skeletonCards(8);
  }
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

/** Renders selected tags for the dashboard UI. */
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

/** Updates tag suggestions for the dashboard UI. */
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

/** Counts non-default search filters for the filter-button badge. */
function activeFilterCount() {
  const from = el<HTMLInputElement>("#dateFrom").value;
  const to = el<HTMLInputElement>("#dateTo").value;
  return [
    el<HTMLInputElement>("#siteInput").value,
    el<HTMLSelectElement>("#favoriteFilter").value,
    // Field, From and To are one date-range filter, so a range counts once
    // however many of its ends are set.
    from || to ? "date" : "",
    el<HTMLSelectElement>("#sortSelect").value !== "added_at" ? "sort" : "",
    el<HTMLSelectElement>("#directionSelect").value !== "desc" ? "direction" : "",
    favoritesOnly ? "favorites" : "",
    notesOnly ? "notes" : "",
  ].filter(Boolean).length;
}

/**
 * Keeps the two ends of the one range consistent: each end bounds the other in
 * the native picker, so an inverted range that silently matches nothing cannot
 * be chosen in the first place.
 */
function syncDateRange(): boolean {
  const from = el<HTMLInputElement>("#dateFrom");
  const to = el<HTMLInputElement>("#dateTo");
  const help = el("#dateFilterHelp");
  from.max = to.value;
  to.min = from.value;
  const inverted = from.value !== "" && to.value !== "" && from.value > to.value;
  from.setAttribute("aria-invalid", inverted ? "true" : "false");
  to.setAttribute("aria-invalid", inverted ? "true" : "false");
  help.textContent = inverted
    ? "The From date is after the To date, so nothing can match."
    : 'Leave either end open for "any time before" or "any time after".';
  help.className = inverted ? "error date-filter-help" : "muted date-filter-help";
  return !inverted;
}

/** Updates filter count for the dashboard UI. */
function updateFilterCount() {
  const count = activeFilterCount();
  el("#filterCount").textContent = count === 0 ? "" : count.toString();
}

/** Renders the editable tag chips for the open bookmark detail panel. */
function detailTags(detail: BookmarkDetail): string {
  return (detail.tags || []).map(tag => '<span class="chip">#' + escapeHtml(tag.display_name) + "</span>").join("") ||
    '<span class="muted">No tags</span>';
}

/** Renders bookmark tags for the dashboard UI. */
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

/** Adds a normalized tag to the bookmark editor when it is not already present. */
function addBookmarkTag(normalized: string, display = normalized): void {
  if (normalized === "" || selectedBookmarkTags.size >= 50) return;
  selectedBookmarkTags.set(normalized, display);
  el<HTMLInputElement>("#bookmarkTagInput").value = "";
  el("#bookmarkTagSuggestions").hidden = true;
  el<HTMLInputElement>("#bookmarkTagInput").setAttribute("aria-expanded", "false");
  el("#bookmarkTagHelp").textContent = "Type # to choose an existing tag or create a new one.";
  renderBookmarkTags();
}

/** Updates bookmark tag suggestions for the dashboard UI. */
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

/* ---- Linked bookmark picker -------------------------------------------
 * The editor used to take a raw related-bookmark URL, which meant leaving the
 * dialog to go and find that URL. This searches the library the same way the
 * extension popup does. The chosen URL still lands in the hidden
 * #bookmarkLinkedUrl field, so the save path is unchanged.
 */
let linkedSearchTimer: ReturnType<typeof setTimeout> | null = null;
let linkedSearchGeneration = 0;

/** Sets linked help for the dashboard UI. */
function setLinkedHelp(message: string): void {
  el("#bookmarkLinkedHelp").textContent = message;
}

/** Hides linked suggestions for the dashboard UI. */
function hideLinkedSuggestions(): void {
  const menu = el("#bookmarkLinkedSuggestions");
  menu.hidden = true;
  menu.innerHTML = "";
  el<HTMLInputElement>("#bookmarkLinkedSearch").setAttribute("aria-expanded", "false");
}

/** Clears linked bookmark for the dashboard UI. */
function clearLinkedBookmark(focus = false): void {
  linkedSearchGeneration += 1;
  if (linkedSearchTimer !== null) {
    clearTimeout(linkedSearchTimer);
    linkedSearchTimer = null;
  }
  el<HTMLInputElement>("#bookmarkLinkedUrl").value = "";
  el("#bookmarkLinkedSelected").hidden = true;
  el("#bookmarkLinkedLabel").textContent = "";
  const search = el<HTMLInputElement>("#bookmarkLinkedSearch");
  search.hidden = false;
  search.value = "";
  hideLinkedSuggestions();
  setLinkedHelp("Type at least 2 characters to search your bookmarks.");
  if (focus) search.focus();
}

/** Shows linked bookmark for the dashboard UI. */
function showLinkedBookmark(url: string, label: string, detail = ""): void {
  el<HTMLInputElement>("#bookmarkLinkedUrl").value = url;
  el("#bookmarkLinkedLabel").textContent = label;
  el("#bookmarkLinkedSelected").hidden = false;
  el<HTMLInputElement>("#bookmarkLinkedSearch").hidden = true;
  setLinkedHelp(detail === "" ? "One linked bookmark selected." : detail);
  hideLinkedSuggestions();
}

/** Builds the folder-and-host subtitle for a linked-bookmark suggestion. */
function linkedSuggestionDetail(bookmark: Bookmark): string {
  return [bookmark.hostname, bookmark.folder_name].filter(Boolean).join(" · ");
}

/** Renders accessible linked-bookmark search suggestions. */
function linkedSuggestionMarkup(bookmark: Bookmark): string {
  const label = bookmark.title || bookmark.url;
  const detail = linkedSuggestionDetail(bookmark);
  return '<button type="button" role="option" data-linked-url="' + escapeHtml(bookmark.url) +
    '" data-linked-label="' + escapeHtml(label) + '" data-linked-detail="' + escapeHtml(detail) +
    '"><span class="suggestion-copy"><strong>' + escapeHtml(label) + "</strong>" +
    (detail === "" ? "" : "<small>" + escapeHtml(detail) + "</small>") +
    "</span></button>";
}

/** Schedules linked search for the dashboard UI. */
function scheduleLinkedSearch(): void {
  const search = el<HTMLInputElement>("#bookmarkLinkedSearch");
  const query = search.value.trim();
  linkedSearchGeneration += 1;
  const generation = linkedSearchGeneration;
  if (linkedSearchTimer !== null) clearTimeout(linkedSearchTimer);
  if (query.length < 2) {
    hideLinkedSuggestions();
    setLinkedHelp("Type at least 2 characters to search your bookmarks.");
    return;
  }
  setLinkedHelp("Searching…");
  linkedSearchTimer = setTimeout(() => {
    void (async () => {
      try {
        const params = new URLSearchParams({ q: query, limit: "8", sort: "added_at", direction: "desc" });
        const result = await api<BookmarkPageResponse>("/api/bookmarks?" + params.toString());
        // A stale response must never overwrite a newer query's suggestions.
        if (generation !== linkedSearchGeneration) return;
        const editingId = el<HTMLInputElement>("#bookmarkId").value;
        const currentUrl = el<HTMLInputElement>("#bookmarkUrl").value.trim();
        const matches = result.bookmarks.filter(
          bookmark => bookmark.id !== editingId && bookmark.url !== currentUrl,
        );
        const menu = el("#bookmarkLinkedSuggestions");
        menu.innerHTML = matches.map(linkedSuggestionMarkup).join("");
        menu.hidden = menu.childElementCount === 0;
        search.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
        menu.querySelectorAll<HTMLButtonElement>("[data-linked-url]").forEach(button => {
          button.addEventListener("click", () => {
            showLinkedBookmark(
              button.dataset.linkedUrl ?? "",
              button.dataset.linkedLabel ?? "",
              button.dataset.linkedDetail ?? "",
            );
          });
        });
        setLinkedHelp(matches.length === 0
          ? "No matching bookmarks found."
          : "Choose one existing bookmark.");
      } catch (error) {
        if (generation !== linkedSearchGeneration) return;
        hideLinkedSuggestions();
        setLinkedHelp(messageOf(error));
      }
    })();
  }, 220);
}

/** Resets bookmark tag editor for the dashboard UI. */
function resetBookmarkTagEditor(tags: BookmarkDetail["tags"] = []): void {
  selectedBookmarkTags.clear();
  for (const tag of tags) selectedBookmarkTags.set(tag.normalized_name, tag.display_name);
  el<HTMLInputElement>("#bookmarkTagInput").value = "";
  el("#bookmarkTagSuggestions").hidden = true;
  renderBookmarkTags();
}

/** Shows detail for the dashboard UI. */
function showDetail(detail: BookmarkDetail): void {
  currentBookmark = detail;
  el("#bookmarkDetailView").hidden = false;
  el<HTMLFormElement>("#bookmarkForm").hidden = true;
  el("#detailFolder").textContent = detail.folder_name + (detail.favorite ? " · Favorite" : "");
  el("#detailTitle").textContent = detail.title;
  el("#detailPreview").innerHTML = previewImage(detail, "thumbnail");
  el("#detailDescription").textContent = detail.description || "No description yet.";
  const review = el("#detailReviewReason");
  review.hidden = detail.review_reason === null;
  review.textContent = detail.review_reason === null
    ? ""
    : reviewReasonLabel(detail.review_reason) +
      (detail.diagnostic_id === null ? "" : " · Diagnostic " + detail.diagnostic_id);
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

let activeXDestinationReviewId: string | null = null;

/** Loads and opens the duplicate-destination overlay for one Share Sheet X post. */
async function openXDestinationReview(bookmarkId: string): Promise<void> {
  if (bookmarkId === "") return;
  const response = await api<{ review: XDestinationReview }>(
    "/api/bookmarks/" + bookmarkId + "/x-destination-review",
  );
  activeXDestinationReviewId = bookmarkId;
  el("#xDestinationReviewItems").innerHTML = response.review.items.map(item => {
    const posts = item.linkedPosts.map(post =>
      '<li><a href="' + escapeHtml(post.url) + '" target="_blank" rel="noreferrer">' +
      escapeHtml(post.title) + "</a></li>"
    ).join("");
    return '<article class="x-review-item"><label><input type="checkbox" data-x-review-choice="' +
      escapeHtml(item.id) + '" checked><span>' + escapeHtml(item.existingTitle || item.destinationUrl) +
      '</span></label><article class="x-review-item current"><strong>New post · currently in review</strong></article>' +
      (posts === "" ? '<p class="muted">No other saved X posts use this destination.</p>' :
        '<p class="muted">Other saved X posts using this destination:</p><ul class="x-review-posts">' + posts + "</ul>") +
      "</article>";
  }).join("");
  el("#xDestinationReviewStatus").textContent = "";
  el<HTMLDialogElement>("#xDestinationReviewDialog").showModal();
}

/** Opens the selected bookmark detail and loads its editable relationships. */
async function openBookmark(id: string): Promise<void> {
  const detail = (await api<{ bookmark: BookmarkDetail }>("/api/bookmarks/" + id)).bookmark;
  showDetail(detail);
  el<HTMLDialogElement>("#bookmarkDialog").showModal();
}

/** Copies bookmark detail into the editor fields and resets transient controls. */
function populateEditor(detail: BookmarkDetail | null): void {
  el("#bookmarkDetailView").hidden = true;
  el<HTMLFormElement>("#bookmarkForm").hidden = false;
  const related = detail?.relatedBookmarks?.[0] || null;
  const linkedInput = el<HTMLInputElement>("#bookmarkLinkedUrl");
  el<HTMLInputElement>("#bookmarkId").value = detail?.id || "";
  el<HTMLInputElement>("#bookmarkRevision").value = String(detail?.revision ?? "");
  el<HTMLInputElement>("#relatedBookmarkId").value = related?.id || "";
  el<HTMLInputElement>("#bookmarkUrl").value = detail?.url || "";
  clearLinkedBookmark();
  if (related !== null) showLinkedBookmark(related.url, related.title || related.url);
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

/**
 * The sidebar is a drawer below 900px. Only the narrow layout renders the
 * toggle, so the wide layout is unaffected and needs no matching teardown.
 */
function initSidebarDrawer(): void {
  const toggle = maybe<HTMLButtonElement>("#sidebarToggle");
  const sidebar = maybe("#appSidebar");
  const scrim = maybe("#sidebarScrim");
  if (toggle === null || sidebar === null || scrim === null) return;

  /** Sets open for the dashboard UI. */
  const setOpen = (open: boolean): void => {
    document.body.classList.toggle("sidebar-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    scrim.hidden = !open;
    if (open) sidebar.querySelector<HTMLElement>("button, a")?.focus();
    else toggle.focus();
  };

  toggle.addEventListener("click", () => {
    setOpen(!document.body.classList.contains("sidebar-open"));
  });
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && document.body.classList.contains("sidebar-open")) {
      setOpen(false);
    }
  });
  /*
   * Choosing a folder or topic is the end of what the drawer is for.
   *
   * Capture phase, because a folder button's own handler re-renders the whole
   * navigation: by the time a bubbling listener ran, the clicked button would be
   * detached and `closest` would no longer find it inside the sidebar.
   */
  sidebar.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("#folderNavigation button, #tagNavigation button, #addBookmarkButton") === null) return;
    if (document.body.classList.contains("sidebar-open")) setOpen(false);
  }, { capture: true });
  // Growing past the breakpoint leaves the permanent sidebar visible, so the
  // open state and its scroll lock have to be dropped.
  const wide = window.matchMedia("(min-width: 901px)");
  wide.addEventListener("change", event => {
    if (event.matches && document.body.classList.contains("sidebar-open")) {
      document.body.classList.remove("sidebar-open");
      toggle.setAttribute("aria-expanded", "false");
      scrim.hidden = true;
    }
  });
}

if (page === "dashboard") {
  initHowTo();
  initSidebarDrawer();
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
  initAiNotice();
  void (async () => {
    await refreshLibraryViews();
    showAiNotice();
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

  /**
   * Bookmarks also arrive from the extension and the iOS Shortcut, and AI moves
   * them out of Unsorted long after the page loaded. Neither reaches this tab,
   * so the sidebar counts and the grid can go stale.
   *
   * There is no interval. Coming back to the tab is a real event — and the one
   * moment a capture has almost certainly just happened — so that is what
   * triggers a check. The check reads state, compares it against what is already
   * painted, and returns without touching the DOM when nothing changed, so a
   * repaint only ever follows a state change. Repaints from the owner's own
   * edits stay immediate, driven by the mutation that caused them.
   */
  let refreshing = false;
  /** Repaints if state changed for the dashboard UI. */
  const repaintIfStateChanged = async (): Promise<void> => {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      await loadBootstrap();
      const fingerprint = libraryFingerprint();
      if (fingerprint === lastLibraryFingerprint) return;
      lastLibraryFingerprint = fingerprint;
      renderFolders();
      renderTagNavigation();
      renderAiAlert();
      await loadBookmarks(false, true);
      /*
       * Counts are read before the list, so anything the queue moves between
       * the two requests leaves them disagreeing — a sidebar reading "Unsorted
       * 1" beside a folder that opens empty, because AI filed the bookmark in
       * the gap. Re-reading after the list closes that window: the counts end
       * up at least as fresh as the rows they label.
       */
      await loadBootstrap();
      const settled = libraryFingerprint();
      if (settled !== lastLibraryFingerprint) {
        lastLibraryFingerprint = settled;
        renderFolders();
        renderTagNavigation();
        renderAiAlert();
      }
    } catch {
      // A failed check leaves the last good view; the next one recovers it.
    } finally {
      refreshing = false;
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void repaintIfStateChanged();
  });
  window.addEventListener("focus", () => void repaintIfStateChanged());

  /*
   * The live connection. Organizing happens in a queue consumer minutes after
   * a capture, in another isolate, so nothing in this tab is party to that
   * write — there is no local event to react to. This is that missing event:
   * the consumer announces the change and the tab checks, so a repaint is still
   * only ever a consequence of state having actually changed.
   *
   * The reconnect delay is a connection backoff, not a refresh interval: it
   * governs when a dropped socket is re-established, never when the DOM is
   * touched.
   */
  /** Connects live updates for the dashboard UI. */
  const connectLiveUpdates = (): void => {
    let socket: WebSocket | null = null;
    let reconnectDelay = 1000;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    /** Stops keep alive for the dashboard UI. */
    const stopKeepAlive = (): void => {
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    };

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Schedules reconnect for the dashboard UI. */
    const scheduleReconnect = (delay: number): void => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, delay);
    };

    /** Opens the UI or connection managed by its enclosing component. */
    const open = (): void => {
      if (socket !== null) return;
      const endpoint = (location.protocol === "https:" ? "wss://" : "ws://") +
        location.host + "/api/events";
      try {
        socket = new WebSocket(endpoint);
      } catch {
        /*
         * Previously this returned and nothing ever tried again, so one failed
         * construction — mid-deploy, offline for a moment — left the page
         * permanently disconnected and silently back to needing a reload.
         */
        socket = null;
        scheduleReconnect(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
        return;
      }
      socket.addEventListener("open", () => {
        reconnectDelay = 1000;
        stopKeepAlive();
        /*
         * Anything announced while this tab was disconnected was announced to
         * nobody — the notification is a signal, not a queue, so there is
         * nothing to replay. Checking once on every connection is what makes a
         * dropped socket self-healing instead of a silent stall until reload.
         */
        void repaintIfStateChanged();
        // Intermediaries drop a silent socket; this keeps it answered.
        keepAlive = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, 45_000);
      });
      socket.addEventListener("message", event => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if ((payload as { type?: unknown }).type !== "library-changed") return;
        void repaintIfStateChanged();
      });
      socket.addEventListener("close", () => {
        stopKeepAlive();
        socket = null;
        // Backing off avoids hammering a deployment that is redeploying.
        scheduleReconnect(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    /*
     * A backgrounded tab has its timers throttled to minutes, so a socket that
     * dies while the tab is away — sleep, a redeploy, a network change — can
     * still be waiting on its backoff when the owner looks again. Returning to
     * the tab is the moment a live connection matters, so it reconnects then
     * rather than whenever the timer happens to come round.
     */
    /** Restores the dragged bookmark when the drop target rejects the move. */
    const reviveIfDropped = (): void => {
      if (document.hidden) return;
      if (socket === null || socket.readyState === WebSocket.CLOSED) {
        reconnectDelay = 1000;
        socket = null;
        open();
      }
    };
    document.addEventListener("visibilitychange", reviveIfDropped);
    window.addEventListener("focus", reviveIfDropped);
    window.addEventListener("online", reviveIfDropped);

    open();
    window.addEventListener("pagehide", () => {
      stopKeepAlive();
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
    }, { once: true });
  };
  connectLiveUpdates();

  /** Binds toolbar toggle for the dashboard UI. */
  const bindToolbarToggle = (
    selector: string,
    read: () => boolean,
    write: (next: boolean) => void,
  ): void => {
    const button = el<HTMLButtonElement>(selector);
    button.addEventListener("click", () => {
      write(!read());
      button.classList.toggle("active", read());
      button.setAttribute("aria-pressed", read() ? "true" : "false");
      updateFilterCount();
      void loadBookmarks();
    });
  };
  bindToolbarToggle("#favoritesToggle", () => favoritesOnly, next => { favoritesOnly = next; });
  bindToolbarToggle("#notesToggle", () => notesOnly, next => { notesOnly = next; });

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
    if (!(event.target instanceof Element) || event.target.closest(".bookmark-link-field") === null) {
      hideLinkedSuggestions();
    }
  });
  el<HTMLInputElement>("#bookmarkLinkedSearch").addEventListener("input", scheduleLinkedSearch);
  el<HTMLInputElement>("#bookmarkLinkedSearch").addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      hideLinkedSuggestions();
    }
  });
  el<HTMLButtonElement>("#bookmarkLinkedClear").addEventListener("click", () => clearLinkedBookmark(true));
  el<HTMLButtonElement>("#filterButton").addEventListener("click", () => el<HTMLDialogElement>("#filterDialog").showModal());
  el<HTMLInputElement>("#dateFrom").addEventListener("change", () => syncDateRange());
  el<HTMLInputElement>("#dateTo").addEventListener("change", () => syncDateRange());
  el<HTMLFormElement>("#filterForm").addEventListener("submit", event => {
    if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return;
    event.preventDefault();
    // An inverted range keeps the dialog open rather than applying a filter
    // that can only ever return nothing.
    if (!syncDateRange()) return;
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
    syncDateRange();
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
  el<HTMLButtonElement>("#closeXDestinationReview").addEventListener("click", () => {
    el<HTMLDialogElement>("#xDestinationReviewDialog").close();
  });
  el<HTMLButtonElement>("#cancelXDestinationReview").addEventListener("click", () => {
    el<HTMLDialogElement>("#xDestinationReviewDialog").close();
  });
  el<HTMLButtonElement>("#keepReviewedXPost").addEventListener("click", async () => {
    if (activeXDestinationReviewId === null) return;
    const selectedReviewIds = all<HTMLInputElement>("[data-x-review-choice]:checked")
      .map(box => box.dataset.xReviewChoice ?? "")
      .filter(Boolean);
    const button = el<HTMLButtonElement>("#keepReviewedXPost");
    button.disabled = true;
    el("#xDestinationReviewStatus").textContent = "Saving decision…";
    try {
      await api("/api/bookmarks/" + activeXDestinationReviewId + "/x-destination-review", {
        method: "POST",
        body: JSON.stringify({ selectedReviewIds }),
      });
      el<HTMLDialogElement>("#xDestinationReviewDialog").close();
      activeXDestinationReviewId = null;
      await refreshLibraryViews();
    } catch (error) {
      el("#xDestinationReviewStatus").textContent = messageOf(error);
    } finally {
      button.disabled = false;
    }
  });
  el<HTMLButtonElement>("#removeReviewedXPost").addEventListener("click", async () => {
    if (activeXDestinationReviewId === null) return;
    const bookmarkId = activeXDestinationReviewId;
    const button = el<HTMLButtonElement>("#removeReviewedXPost");
    button.disabled = true;
    try {
      await api("/api/bookmarks/" + bookmarkId + "/trash", { method: "POST", body: "{}" });
      el<HTMLDialogElement>("#xDestinationReviewDialog").close();
      activeXDestinationReviewId = null;
      await refreshLibraryViews();
    } catch (error) {
      el("#xDestinationReviewStatus").textContent = messageOf(error);
    } finally {
      button.disabled = false;
    }
  });
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

/** Shows secret for the dashboard UI. */
function showSecret(selector: string, value: string): void {
  el(selector).textContent = value;
}

/**
 * Confirms a copy on the button itself, then puts it back.
 *
 * The confirmation used to be a sentence in a status line elsewhere on the
 * panel, which is easy to miss when your attention is on the thing you just
 * clicked. Failure still goes to the status line, because "nothing was copied,
 * select it by hand" is more than a button can say.
 */
const copyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

/** Copies secret for the dashboard UI. */
async function copySecret(
  valueSelector: string,
  statusSelector: string,
  button: HTMLButtonElement,
): Promise<void> {
  const value = el(valueSelector).textContent?.trim() ?? "";
  if (value.length === 0) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    el(statusSelector).textContent = "Copy failed. Select and copy the value manually.";
    return;
  }
  el(statusSelector).textContent = "";
  // Clicking again before it reverts restarts the confirmation rather than
  // letting the earlier timer put the original label back mid-flash.
  const running = copyResetTimers.get(button);
  if (running !== undefined) clearTimeout(running);
  else {
    button.dataset.copyLabel = button.textContent ?? "Copy";
    // Hold the width the label had, so the row does not reflow between
    // "Copy code" and the shorter "Copied" and back.
    button.style.minWidth = `${button.getBoundingClientRect().width.toString()}px`;
  }
  button.textContent = "Copied";
  button.classList.add("copied");
  copyResetTimers.set(button, setTimeout(() => {
    button.textContent = button.dataset.copyLabel ?? "Copy";
    button.classList.remove("copied");
    button.style.minWidth = "";
    copyResetTimers.delete(button);
  }, 1600));
}

/** Renders automation progress for the dashboard UI. */
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

/**
 * Message and colour are one thing. Setting only textContent is what left a
 * failure's red styling attached to the next success message.
 */
function setStatus(selector: string, text: string, kind: "" | "error" | "loading" = ""): void {
  const node = el(selector);
  node.textContent = text;
  node.className = kind === "" ? "status" : "status " + kind;
}

interface McpConnection {
  id: string;
  clientType: "chatgpt" | "claude" | "other";
  displayName: string;
  scope: "library:read";
  connectedAt: string;
  lastUsedAt: string | null;
}

interface McpConnectionsResponse {
  endpoint: string;
  connections: McpConnection[];
}

/** Describes privacy-safe connection activity without exposing exact request history. */
function mcpLastUsedLabel(value: string | null): string {
  if (value === null) return "Not used yet";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Last used just now";
  if (elapsed < 60 * 60_000) {
    const minutes = Math.max(1, Math.floor(elapsed / 60_000));
    return `Last used ${minutes.toString()} min ago`;
  }
  if (elapsed < 24 * 60 * 60_000) {
    const hours = Math.max(1, Math.floor(elapsed / (60 * 60_000)));
    return `Last used ${hours.toString()} hr ago`;
  }
  return `Last used ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  )}`;
}

/** Renders the owner's independently revocable OAuth connections using safe DOM APIs. */
function renderMcpConnections(connections: McpConnection[]): void {
  const list = el("#mcpConnections");
  list.replaceChildren();
  if (connections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No AI assistants connected yet.";
    list.appendChild(empty);
    return;
  }
  for (const connection of connections) {
    const row = document.createElement("article");
    row.className = "ai-connection";
    const copy = document.createElement("div");
    copy.className = "ai-connection-copy";
    const title = document.createElement("p");
    title.className = "ai-connection-title";
    title.appendChild(document.createTextNode(`${connection.displayName} — Connected `));
    const check = document.createElement("span");
    check.className = "connection-check";
    check.setAttribute("aria-label", "connected");
    check.textContent = "✓";
    title.appendChild(check);
    const meta = document.createElement("p");
    meta.className = "ai-connection-meta";
    meta.textContent = `Read-only access · ${mcpLastUsedLabel(connection.lastUsedAt)}`;
    copy.appendChild(title);
    copy.appendChild(meta);
    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.className = "secondary";
    disconnect.textContent = "Disconnect";
    disconnect.addEventListener("click", async () => {
      disconnect.disabled = true;
      disconnect.textContent = "Disconnecting…";
      try {
        await api(`/api/mcp/connections/${encodeURIComponent(connection.id)}`, {
          method: "DELETE",
        });
        await loadMcpConnections();
        setStatus("#mcpConnectionStatus", `${connection.displayName} disconnected.`);
      } catch (error) {
        disconnect.disabled = false;
        disconnect.textContent = "Disconnect";
        setStatus("#mcpConnectionStatus", messageOf(error), "error");
      }
    });
    row.appendChild(copy);
    row.appendChild(disconnect);
    list.appendChild(row);
  }
}

/** Refreshes the stable MCP address and the active per-assistant OAuth grants. */
async function loadMcpConnections(): Promise<void> {
  const response = await api<McpConnectionsResponse>("/api/mcp/connections");
  el("#mcpEndpoint").textContent = response.endpoint;
  renderMcpConnections(response.connections);
}

/** Renders independently revocable Chrome devices without exposing capture tokens. */
function renderExtensionDevices(devices: ExtensionDevice[]): void {
  const container = el("#extensionDevices");
  container.replaceChildren();
  if (devices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No Chrome devices connected yet.";
    container.appendChild(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement("article");
    row.className = "ai-connection";
    const copy = document.createElement("div");
    const title = document.createElement("p");
    title.className = "ai-connection-title";
    title.textContent = device.name;
    const meta = document.createElement("p");
    meta.className = "ai-connection-meta";
    meta.textContent = `Connected ${friendlyDate(device.connectedAt)} · ${mcpLastUsedLabel(device.lastUsedAt)}`;
    copy.appendChild(title);
    copy.appendChild(meta);
    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.className = "secondary";
    disconnect.textContent = "Disconnect";
    disconnect.addEventListener("click", async () => {
      disconnect.disabled = true;
      try {
        await api(`/api/capture/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
        await loadExtensionDevices();
        setStatus("#extensionDeviceStatus", `${device.name} disconnected.`);
      } catch (error: unknown) {
        disconnect.disabled = false;
        setStatus("#extensionDeviceStatus", messageOf(error), "error");
      }
    });
    row.appendChild(copy);
    row.appendChild(disconnect);
    container.appendChild(row);
  }
}

/** Loads safe device names and timestamps from the personal runtime. */
async function loadExtensionDevices(): Promise<void> {
  const response = await api<{ devices: ExtensionDevice[] }>("/api/capture/devices");
  renderExtensionDevices(response.devices);
}

/** Opens an external setup page while keeping the self-hosted endpoint easy to paste. */
async function openMcpSetup(destination: string, assistant: string): Promise<void> {
  const endpoint = el("#mcpEndpoint").textContent?.trim() || `${location.origin}/mcp`;
  window.open(destination, "_blank", "noopener,noreferrer");
  try {
    await navigator.clipboard.writeText(endpoint);
    setStatus(
      "#mcpConnectionStatus",
      `${assistant} setup opened. The Later Gator address is copied—paste it when asked.`,
    );
  } catch {
    setStatus(
      "#mcpConnectionStatus",
      `${assistant} setup opened. Copy the address under Advanced connection details if asked.`,
    );
  }
}

/** Loads settings for the dashboard UI. */
async function loadSettings() {
  bootstrap = (await api<{ state: BootstrapState }>("/api/bootstrap")).state;
  const providerSelect = el<HTMLSelectElement>("#providerName");
  const providerModel = el<HTMLSelectElement>("#providerModel");
  // Settings polls every 5s. Overwriting these fields mid-edit made the model
  // box impossible to type into, and replaced the result of a test the owner
  // had just run with a stale "ready".
  if (providerModel.dataset.dirty !== "true") {
    providerSelect.value = state().provider.provider;
    renderProviderModels(state().provider.provider, state().provider.model);
  }
  const gateway = maybe<HTMLInputElement>("#aiGatewayId");
  if (gateway !== null && gateway.dataset.dirty !== "true") {
    gateway.value = state().provider.ai_gateway_id ?? "";
  }
  if (el("#providerStatus").dataset.transient !== "true") {
    // The raw safe code used to be printed here, so the same pause read one way
    // in Settings and another in the test result.
    setStatus(
      "#providerStatus",
      state().provider.operational_status === "waiting"
        ? providerStatusMessage(
            state().provider.last_safe_error_code,
            "AI needs attention: the provider is unavailable.",
          )
        : "AI provider is ready.",
      state().provider.operational_status === "waiting" ? "error" : "",
    );
  }
  renderAutomationProgress();
  el<HTMLButtonElement>("#automationButton").textContent = state().ownerAiPaused ? "Resume AI" : "Pause AI";
  const instructions = el<HTMLTextAreaElement>("#settingsPersonalInstructions");
  if (instructions.dataset.dirty !== "true") {
    instructions.value = state().personalInstructions ?? "";
  }
  toggleKey();
  return bootstrap;
}

/** Maps the runtime's provider name to the public catalog's provider name. */
function catalogProvider(provider: string): CatalogModel["provider"] {
  return provider === "workers-ai" ? "cloudflare" : provider as CatalogModel["provider"];
}

/** Renders signed model choices while retaining an unknown active model visibly. */
function renderProviderModels(provider: string, selectedModel?: string): void {
  const select = el<HTMLSelectElement>("#providerModel");
  const models = publicModelCatalog?.models.filter(
    (model) => model.provider === catalogProvider(provider),
  ) ?? [];
  const current = selectedModel ?? select.value;
  select.replaceChildren();
  if (current !== "" && !models.some((model) => model.modelId === current)) {
    const unavailable = document.createElement("option");
    unavailable.value = current;
    unavailable.textContent = `${current} — current model unavailable in catalog`;
    select.appendChild(unavailable);
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.modelId;
    const deprecated = model.deprecatedAfter !== null ? " — deprecated" : "";
    option.textContent = `${model.displayName}${deprecated}`;
    option.disabled = model.deprecatedAfter !== null && model.modelId !== current;
    select.appendChild(option);
  }
  const preferred = models.find((model) => model.isDefault)?.modelId ?? models[0]?.modelId ?? "";
  select.value = current !== "" ? current : preferred;
  if (select.value === "" && preferred !== "") select.value = preferred;
}

/** Renders dated Cloudflare facts as informational links, never quota controls. */
function renderStoragePlanFacts(catalog: StoragePlanCatalog | null): void {
  const container = el("#storagePlanFacts");
  container.replaceChildren();
  if (catalog === null) {
    const fallback = document.createElement("p");
    fallback.className = "muted";
    fallback.textContent = "Current plan information is temporarily unavailable; storage behavior is unchanged.";
    container.appendChild(fallback);
    return;
  }
  const reviewed = document.createElement("p");
  reviewed.className = "muted";
  reviewed.textContent = `Plan facts reviewed ${catalog.reviewedOn}. ${catalog.disclaimer}`;
  container.appendChild(reviewed);
  for (const plan of catalog.plans.filter((entry) => entry.storageVariant !== "disabled")) {
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = plan.title;
    const copy = document.createElement("p");
    copy.className = "muted";
    copy.textContent = `${plan.summary} ${plan.informationalAllowances.join("; ")}.`;
    detail.appendChild(summary);
    detail.appendChild(copy);
    for (const [index, url] of plan.officialUrls.entries()) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = index === 0 ? "Official Cloudflare details ↗" : "Additional limits ↗";
      detail.appendChild(link);
      if (index < plan.officialUrls.length - 1) detail.appendChild(document.createTextNode(" · "));
    }
    container.appendChild(detail);
  }
}

/** Loads the last signature-verified catalogs cached by this installation. */
async function loadPublicCatalogs(): Promise<void> {
  const response = await api<PublicCatalogResponse>("/api/catalogs");
  publicModelCatalog = response.catalogs.models;
  renderStoragePlanFacts(response.catalogs.storagePlans);
  if (bootstrap !== null && el("#providerModel").dataset.dirty !== "true") {
    renderProviderModels(state().provider.provider, state().provider.model);
  }
}

/** Formats an approximate thumbnail byte count without treating it as quota truth. */
function thumbnailByteLabel(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize.toString()} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KiB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Renders storage controls from personal-runtime state only. */
function renderThumbnailStorage(storage: ThumbnailStorageSummary): void {
  const backend = storage.mode === "kv" ? "Workers KV" : storage.mode === "r2" ? "R2" : "Disabled";
  const state = storage.status === "paused" ? " — thumbnail writes paused" : "";
  el("#thumbnailStorageSummary").textContent =
    `${backend}: ${storage.objectCount.toString()} thumbnails (${thumbnailByteLabel(storage.byteSize)})${state}.`;
  const migration = el("#thumbnailStorageMigration");
  migration.hidden = storage.migrationState === null;
  migration.textContent = storage.migrationState === null
    ? ""
    : `Migration state: ${storage.migrationState.replaceAll("_", " ")}.`;
  el<HTMLButtonElement>("#disableThumbnailStorage").hidden = storage.mode === "disabled";
  el<HTMLButtonElement>("#enableKvThumbnailStorage").hidden = storage.mode !== "disabled";
  el<HTMLButtonElement>("#reclaimThumbnailStorage").disabled = storage.objectCount === 0;
  el<HTMLButtonElement>("#migrateThumbnailStorage").hidden =
    storage.mode !== "kv" || storage.migrationState !== null;
  const approve = el<HTMLButtonElement>("#approveThumbnailCleanup");
  approve.hidden = storage.migrationState !== "awaiting_cleanup";
  approve.dataset.migrationId = storage.migrationId ?? "";
  if (storage.safeErrorCode !== null && storage.status === "paused") {
    setStatus(
      "#thumbnailStorageStatus",
      "Thumbnail storage needs attention. Bookmarks and AI are still available.",
      "error",
    );
  }
}

/** Refreshes the personal thumbnail-storage status shown in Settings. */
async function loadThumbnailStorage(): Promise<void> {
  const response = await api<ThumbnailStorageResponse>("/api/storage/thumbnails");
  renderThumbnailStorage(response.storage);
}

/** Toggles key for the dashboard UI. */
function toggleKey() {
  el("#providerKeyLabel").hidden = el<HTMLSelectElement>("#providerName").value === "workers-ai";
}

if (page === "settings") {
  initHowTo();
  let settingsPageActive = true;
  /** Displays an actionable settings error and reports whether handling should stop. */
  const shouldReportSettingsError = (): boolean =>
    settingsPageActive && !document.hidden && document.body.dataset.page === "settings";
  void (async () => {
    try {
      await Promise.all([
        loadSettings(),
        loadMcpConnections(),
        loadExtensionDevices(),
        loadThumbnailStorage(),
        loadPublicCatalogs(),
      ]);
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
  /** Marks the provider fields as owner-edited so the poll stops overwriting them. */
  const markProviderDirty = (): void => {
    el<HTMLSelectElement>("#providerModel").dataset.dirty = "true";
  };
  /** Releases provider fields for the dashboard UI. */
  const releaseProviderFields = (): void => {
    delete el<HTMLSelectElement>("#providerModel").dataset.dirty;
    delete el("#providerStatus").dataset.transient;
  };
  el<HTMLSelectElement>("#providerModel").addEventListener("change", markProviderDirty);
  el<HTMLInputElement>("#providerKey").addEventListener("input", markProviderDirty);
  el<HTMLSelectElement>("#providerName").addEventListener("change", () => {
    // Each provider names its models differently, so a switch is an edit.
    markProviderDirty();
    renderProviderModels(el<HTMLSelectElement>("#providerName").value);
    toggleKey();
  });
  el<HTMLTextAreaElement>("#settingsPersonalInstructions").addEventListener("input", event => {
    (event.currentTarget as HTMLTextAreaElement).dataset.dirty = "true";
  });
  /** Runs one explicit thumbnail-storage mutation and refreshes its safe status. */
  const mutateThumbnailStorage = async (
    path: string,
    successMessage: string,
    body?: unknown,
  ): Promise<void> => {
    setStatus("#thumbnailStorageStatus", "Updating thumbnail storage…", "loading");
    try {
      await api(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await loadThumbnailStorage();
      setStatus("#thumbnailStorageStatus", successMessage);
    } catch (error: unknown) {
      setStatus("#thumbnailStorageStatus", messageOf(error), "error");
    }
  };
  el<HTMLButtonElement>("#disableThumbnailStorage").addEventListener("click", () => {
    void mutateThumbnailStorage(
      "/api/storage/thumbnails/disable",
      "Future bookmarks will be saved without thumbnails.",
    );
  });
  el<HTMLButtonElement>("#enableKvThumbnailStorage").addEventListener("click", () => {
    void mutateThumbnailStorage(
      "/api/storage/thumbnails/enable-kv",
      "KV thumbnail storage is enabled.",
    );
  });
  el<HTMLButtonElement>("#reclaimThumbnailStorage").addEventListener("click", () => {
    void mutateThumbnailStorage(
      "/api/storage/thumbnails/reclaim",
      "The oldest thumbnail objects were removed; bookmarks were kept.",
      { limit: 100 },
    );
  });
  el<HTMLButtonElement>("#migrateThumbnailStorage").addEventListener("click", () => {
    void mutateThumbnailStorage(
      "/api/storage/thumbnails/migrate-r2",
      "The verified R2 copy has started. KV will remain untouched until approval.",
    );
  });
  el<HTMLButtonElement>("#approveThumbnailCleanup").addEventListener("click", event => {
    const migrationId = (event.currentTarget as HTMLButtonElement).dataset.migrationId ?? "";
    if (migrationId === "") return;
    void mutateThumbnailStorage(
      `/api/storage/thumbnails/migrations/${encodeURIComponent(migrationId)}/approve-cleanup`,
      "KV cleanup was approved and queued.",
    );
  });
  const advanced = maybe<HTMLDialogElement>("#advancedProviderDialog");
  if (advanced !== null) {
    el<HTMLButtonElement>("#openAdvancedProvider").addEventListener("click", () => advanced.showModal());
    el<HTMLButtonElement>("#closeAdvancedProvider").addEventListener("click", () => advanced.close());
    el<HTMLInputElement>("#aiGatewayId").addEventListener("input", event => {
      (event.currentTarget as HTMLInputElement).dataset.dirty = "true";
    });
    el<HTMLButtonElement>("#saveAdvancedProvider").addEventListener("click", async () => {
      // Reuses the activation route, so the gateway is validated by the same
      // test that guards a model change rather than saved unchecked.
      const status = "#advancedProviderStatus";
      setStatus(status, "Saving…", "loading");
      try {
        await api("/api/providers/activate", {
          method: "POST",
          body: JSON.stringify({
            provider: el<HTMLSelectElement>("#providerName").value,
            model: el<HTMLSelectElement>("#providerModel").value.trim(),
            aiGatewayId: el<HTMLInputElement>("#aiGatewayId").value.trim(),
          }),
        });
        delete el<HTMLInputElement>("#aiGatewayId").dataset.dirty;
        await loadSettings();
        setStatus(status, "Saved.");
      } catch (error) {
        setStatus(status, messageOf(error), "error");
      }
    });
  }

  el<HTMLFormElement>("#providerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const status = el("#providerStatus");
    // Hold the poll off this message until the owner acts again.
    status.dataset.transient = "true";
    setStatus("#providerStatus", "Testing provider…", "loading");
    try {
      const provider = el<HTMLSelectElement>("#providerName").value;
      const model = el<HTMLSelectElement>("#providerModel").value.trim();
      const credential = el<HTMLInputElement>("#providerKey").value || null;
      await api("/api/providers/test", { method: "POST", body: JSON.stringify({ provider, model, credential }) });
      await api("/api/providers/activate", {
        method: "POST",
        body: JSON.stringify({
          provider,
          model,
          aiGatewayId: maybe<HTMLInputElement>("#aiGatewayId")?.value.trim() ?? "",
        }),
      });
      // Only a successful activation makes the stored value the truth again.
      releaseProviderFields();
      await loadSettings();
      setStatus("#providerStatus", "Provider activated.");
    } catch (error) {
      // The typed model stays put so it can be corrected rather than retyped.
      setStatus("#providerStatus", messageOf(error), "error");
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
    await copySecret("#iosEndpoint", "#iosCredentialStatus", el<HTMLButtonElement>("#copyIosEndpoint"));
  });
  el<HTMLButtonElement>("#copyIosToken").addEventListener("click", async () => {
    await copySecret("#iosToken", "#iosCredentialStatus", el<HTMLButtonElement>("#copyIosToken"));
  });
  el<HTMLButtonElement>("#connectChatGpt").addEventListener("click", async () => {
    await openMcpSetup("https://chatgpt.com/#settings/Connectors", "ChatGPT");
  });
  el<HTMLButtonElement>("#connectClaude").addEventListener("click", async () => {
    const endpoint = el("#mcpEndpoint").textContent?.trim() || `${location.origin}/mcp`;
    const destination = "https://claude.ai/customize/connectors?modal=add-custom-connector" +
      `&connectorName=${encodeURIComponent("Later Gator")}` +
      `&connectorUrl=${encodeURIComponent(endpoint)}`;
    await openMcpSetup(destination, "Claude");
  });
  el<HTMLButtonElement>("#copyMcpEndpoint").addEventListener("click", async () => {
    await copySecret(
      "#mcpEndpoint",
      "#mcpConnectionStatus",
      el<HTMLButtonElement>("#copyMcpEndpoint"),
    );
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
