"use strict";

const browserApi = globalThis.browser ?? globalThis.chrome;
const connectionCodePrefix = "later-gator-v1.";
let connection = null;
let metadata = {};
let availableTags = [];
let unsortedFolderIds = new Set(["folder_unsorted"]);
let selectedTags = new Map();
let selectedLinkedBookmark = null;
let linkedSearchTimer = null;
let linkedSearchGeneration = 0;

class CaptureRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "CaptureRequestError";
    this.status = status;
  }
}

const byId = id => document.getElementById(id);

function showView(view) {
  byId("loadingPanel").hidden = view !== "loading";
  byId("connectionPanel").hidden = view !== "connection";
  byId("captureForm").hidden = view !== "capture";
  byId("successPanel").hidden = view !== "success";
  byId("connectionSettings").hidden = view !== "capture";
  byId("popupHeader").hidden = view === "success";
}

function showLoading(message = "Connecting to Later Gator…", retry = false) {
  byId("loadingStatus").textContent = message;
  byId("retryButton").hidden = !retry;
  showView("loading");
}

function showConnection(message = "", canCancel = false) {
  byId("connectionCode").value = "";
  byId("connectionStatus").textContent = message;
  byId("cancelConnection").hidden = !canCancel;
  showView("connection");
}

function decodeConnectionCode(value) {
  const code = value.trim();
  if (!code.startsWith(connectionCodePrefix)) {
    throw new Error("Paste the complete connection code from Later Gator Settings.");
  }
  const encoded = code.slice(connectionCodePrefix.length).replaceAll("-", "+").replaceAll("_", "/");
  const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
  let payload;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("This connection code could not be read. Copy a fresh code from Settings.");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.version !== 1 ||
    typeof payload.deployment !== "string" ||
    typeof payload.token !== "string" ||
    payload.token.length < 32 ||
    payload.token.length > 256
  ) {
    throw new Error("This connection code is incomplete. Copy a fresh code from Settings.");
  }
  return { deployment: connectionOrigin(payload.deployment), token: payload.token };
}

function showCapture() {
  showView("capture");
}

function showSuccess(result) {
  const messages = {
    saved: ["Bookmark saved!", "Your bookmark is safely in Later Gator."],
    already_saved: ["Already saved!", "This bookmark was already in your Later Gator library."],
    saved_and_linked: ["Saved and linked!", "Your bookmark and its relationship are safely in Later Gator."],
    source_saved_link_failed: ["Bookmark saved", "The bookmark was saved, but Later Gator could not create the link."],
  };
  const [title, message] = messages[result] || messages.saved;
  byId("successTitle").textContent = title;
  byId("successMessage").textContent = message;
  byId("openLaterGator").href = connection === null ? "#" : connection.deployment + "/dashboard";
  showView("success");
}

async function updateSavedBadge(saved) {
  const tabId = metadata.tabId;
  if (typeof tabId !== "number" || browserApi.action === undefined) return;
  try {
    await browserApi.action.setBadgeBackgroundColor({ color: "#2f7d4f", tabId });
    await browserApi.action.setBadgeText({ text: saved ? "✓" : "", tabId });
    await browserApi.action.setTitle({
      title: saved ? "Saved in Later Gator" : "Save to Later Gator",
      tabId,
    });
  } catch {
    // Saving remains available if a browser does not support per-tab action badges.
  }
}

function connectionOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Enter an HTTPS Later Gator deployment URL.");
  }
  return url.origin;
}

function validStoredConnection(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.deployment !== "string" ||
    typeof value.token !== "string" ||
    value.token.length < 32 ||
    value.token.length > 256
  ) {
    return null;
  }
  try {
    return { deployment: connectionOrigin(value.deployment), token: value.token };
  } catch {
    return null;
  }
}

async function requestWith(target, path, options = {}) {
  let response;
  try {
    response = await fetch(target.deployment + path, {
      ...options,
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new CaptureRequestError("Later Gator is temporarily unavailable.", 0);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON response means this is not a working capture endpoint.
  }
  if (!response.ok) {
    throw new CaptureRequestError(body?.error?.message || "Request failed", response.status);
  }
  if (body === null) throw new CaptureRequestError("The deployment returned an invalid response.", 404);
  return body;
}

function request(path, options = {}) {
  if (connection === null) throw new CaptureRequestError("Reconnect Later Gator.", 401);
  return requestWith(connection, path, options);
}

function isInvalidConnection(error) {
  return error instanceof CaptureRequestError && [400, 401, 403, 404, 405].includes(error.status);
}

async function pageMetadata() {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return {};
  let page = {};
  try {
    const results = await browserApi.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        description:
          document.querySelector('meta[name="description"]')?.content ||
          document.querySelector('meta[property="og:description"]')?.content ||
          "",
        image:
          document.querySelector('meta[property="og:image"]')?.content ||
          document.querySelector('meta[name="twitter:image"]')?.content ||
          "",
      }),
    });
    page = results[0]?.result || {};
  } catch {
    // URL and tab title remain useful when a page does not allow script injection.
  }
  return { tabId: tab.id, url: tab.url, title: tab.title || "", ...page };
}

function normalizeTag(value) {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 64)
    .replace(/-+$/gu, "");
  return normalized === "ai" ? "artificial-intelligence" : normalized;
}

function hideSuggestions(id, inputId) {
  byId(id).hidden = true;
  byId(id).replaceChildren();
  byId(inputId).setAttribute("aria-expanded", "false");
}

function suggestionButton(title, detail, onSelect) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "suggestion";
  button.setAttribute("role", "option");
  const copy = document.createElement("span");
  copy.className = "suggestion-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  copy.append(strong);
  if (detail !== "") {
    const small = document.createElement("small");
    small.textContent = detail;
    copy.append(small);
  }
  button.append(copy);
  button.addEventListener("click", onSelect);
  return button;
}

function renderSelectedTags() {
  const container = byId("selectedTags");
  container.replaceChildren(
    ...[...selectedTags.entries()].map(([normalized, display]) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      const label = document.createElement("span");
      label.textContent = `#${display}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove #${display}`);
      remove.addEventListener("click", () => {
        selectedTags.delete(normalized);
        renderSelectedTags();
      });
      chip.append(label, remove);
      return chip;
    }),
  );
}

function addTag(normalized, display = normalized) {
  if (normalized === "" || selectedTags.size >= 50) return;
  selectedTags.set(normalized, display);
  renderSelectedTags();
  byId("tagInput").value = "";
  byId("tagHelp").textContent = "Type # to choose an existing tag or create a new one.";
  hideSuggestions("tagSuggestions", "tagInput");
}

function renderTagSuggestions() {
  const input = byId("tagInput");
  const raw = input.value.trim();
  const suggestions = byId("tagSuggestions");
  suggestions.replaceChildren();
  if (!raw.startsWith("#")) {
    byId("tagHelp").textContent = raw === ""
      ? "Type # to choose an existing tag or create a new one."
      : "Tags must start with #.";
    hideSuggestions("tagSuggestions", "tagInput");
    return;
  }
  const query = normalizeTag(raw);
  const matches = availableTags
    .filter(tag => {
      const normalized = normalizeTag(tag.normalized_name || tag.display_name || "");
      return !selectedTags.has(normalized) && (query === "" || normalized.includes(query));
    })
    .slice(0, 8);
  for (const tag of matches) {
    const normalized = normalizeTag(tag.normalized_name || tag.display_name || "");
    suggestions.append(suggestionButton(`#${tag.display_name || normalized}`, "", () => {
      addTag(normalized, tag.display_name || normalized);
    }));
  }
  const exactExists = availableTags.some(tag => normalizeTag(tag.normalized_name || tag.display_name || "") === query);
  if (query !== "" && !exactExists && !selectedTags.has(query)) {
    suggestions.append(suggestionButton(`Create #${query}`, "", () => addTag(query)));
  }
  suggestions.hidden = suggestions.childElementCount === 0;
  input.setAttribute("aria-expanded", String(!suggestions.hidden));
  byId("tagHelp").textContent = query === "" ? "Keep typing after # to create a new tag." : "Choose a suggestion or press Enter to add.";
}

function clearLinkedBookmark(focus = false) {
  linkedSearchGeneration += 1;
  if (linkedSearchTimer !== null) {
    clearTimeout(linkedSearchTimer);
    linkedSearchTimer = null;
  }
  selectedLinkedBookmark = null;
  byId("selectedLinkedBookmark").hidden = true;
  byId("selectedLinkedLabel").textContent = "";
  const input = byId("linkedSearch");
  input.hidden = false;
  input.value = "";
  hideSuggestions("linkedSuggestions", "linkedSearch");
  if (focus && !byId("linkedFieldset").disabled) input.focus();
}

function selectLinkedBookmark(bookmark) {
  selectedLinkedBookmark = bookmark;
  byId("selectedLinkedLabel").textContent = bookmark.title || bookmark.url;
  byId("selectedLinkedBookmark").hidden = false;
  byId("linkedSearch").hidden = true;
  byId("linkedHelp").textContent = `${bookmark.hostname || "Bookmark"} · ${bookmark.folder_name || "Later Gator"}`;
  hideSuggestions("linkedSuggestions", "linkedSearch");
}

function renderLinkedSuggestions(bookmarks) {
  const suggestions = byId("linkedSuggestions");
  suggestions.replaceChildren();
  for (const bookmark of bookmarks) {
    suggestions.append(suggestionButton(
      bookmark.title || bookmark.url,
      [bookmark.hostname, bookmark.folder_name].filter(Boolean).join(" · "),
      () => selectLinkedBookmark(bookmark),
    ));
  }
  suggestions.hidden = suggestions.childElementCount === 0;
  byId("linkedSearch").setAttribute("aria-expanded", String(!suggestions.hidden));
  byId("linkedHelp").textContent = bookmarks.length === 0
    ? "No existing bookmarks found."
    : "Choose one existing bookmark.";
}

function scheduleLinkedSearch() {
  selectedLinkedBookmark = null;
  byId("selectedLinkedBookmark").hidden = true;
  const query = byId("linkedSearch").value.trim();
  linkedSearchGeneration += 1;
  const generation = linkedSearchGeneration;
  if (linkedSearchTimer !== null) clearTimeout(linkedSearchTimer);
  if (query.length < 2) {
    hideSuggestions("linkedSuggestions", "linkedSearch");
    byId("linkedHelp").textContent = "Type at least 2 characters to search your bookmarks.";
    return;
  }
  byId("linkedHelp").textContent = "Searching…";
  linkedSearchTimer = setTimeout(async () => {
    try {
      const body = await request("/api/capture/bookmark-search", {
        method: "POST",
        body: JSON.stringify({ query }),
      });
      if (generation !== linkedSearchGeneration) return;
      renderLinkedSuggestions(
        body.bookmarks.filter(bookmark => bookmark.url !== metadata.url),
      );
    } catch (error) {
      if (generation !== linkedSearchGeneration) return;
      hideSuggestions("linkedSuggestions", "linkedSearch");
      if (isInvalidConnection(error)) {
        await discardConnection("This connection is no longer valid. Generate a fresh connection code in Settings.");
      } else {
        byId("linkedHelp").textContent = "Bookmark search is temporarily unavailable.";
      }
    }
  }, 200);
}

function syncFolderFields() {
  const isUnsorted = unsortedFolderIds.has(byId("folder").value);
  byId("tagFieldset").disabled = isUnsorted;
  byId("linkedFieldset").disabled = isUnsorted;
  if (isUnsorted) {
    selectedTags = new Map();
    renderSelectedTags();
    byId("tagInput").value = "";
    hideSuggestions("tagSuggestions", "tagInput");
    byId("tagHelp").textContent = "Unsorted bookmarks are organized by AI, so tags are unavailable.";
    clearLinkedBookmark();
    byId("linkedHelp").textContent = "Unsorted bookmarks are organized by AI, so linking is unavailable.";
    return;
  }
  byId("tagHelp").textContent = "Type # to choose an existing tag or create a new one.";
  byId("linkedHelp").textContent = "Type at least 2 characters to search your bookmarks.";
}

function fillOptions(options) {
  availableTags = Array.isArray(options.tags) ? options.tags : [];
  unsortedFolderIds = new Set(
    options.folders.filter(item => item.slug === "unsorted").map(item => item.id),
  );
  const folder = byId("folder");
  folder.replaceChildren(
    ...options.folders.map(item => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      option.selected = item.slug === "unsorted";
      return option;
    }),
  );
  syncFolderFields();
}

async function prepareCapture(options, activePage = null) {
  metadata = activePage ?? await pageMetadata().catch(() => ({}));
  selectedTags = new Map();
  clearLinkedBookmark();
  byId("pageTitle").textContent = metadata.title || "Current page";
  byId("pageDescription").textContent = metadata.description || "";
  byId("preview").hidden = !metadata.image;
  if (metadata.image) byId("preview").src = metadata.image;
  fillOptions(options);
}

async function loadCaptureState(target) {
  const activePagePromise = pageMetadata().catch(() => ({}));
  const optionsPromise = requestWith(target, "/api/capture/options", {
    method: "GET",
    headers: {},
  });
  const activePage = await activePagePromise;
  const savedPromise = typeof activePage.url === "string" && activePage.url !== ""
    ? requestWith(target, "/api/capture/bookmark-status", {
        method: "POST",
        body: JSON.stringify({ url: activePage.url }),
      }).catch(() => ({ saved: false }))
    : Promise.resolve({ saved: false });
  const [options, status] = await Promise.all([optionsPromise, savedPromise]);
  return { options, activePage, saved: status.saved === true };
}

async function presentCaptureState(state) {
  await prepareCapture(state.options, state.activePage);
  await updateSavedBadge(state.saved);
  if (state.saved) showSuccess("already_saved");
  else showCapture();
}

async function discardConnection(message) {
  connection = null;
  await browserApi.storage.local.remove("laterGatorConnection");
  showConnection(message);
}

async function initialize() {
  showLoading();
  const stored = await browserApi.storage.local.get("laterGatorConnection");
  connection = validStoredConnection(stored.laterGatorConnection) ?? null;
  if (connection === null) {
    await browserApi.storage.local.remove("laterGatorConnection");
    showConnection();
    return;
  }

  const hasPermission = await browserApi.permissions.contains({
    origins: [connection.deployment + "/*"],
  });
  if (!hasPermission) {
    await discardConnection("Reconnect to restore access to this deployment.");
    return;
  }

  try {
    await presentCaptureState(await loadCaptureState(connection));
  } catch (error) {
    if (isInvalidConnection(error)) {
      await discardConnection("This connection is no longer valid. Generate a fresh connection code in Settings.");
      return;
    }
    showLoading("Later Gator is temporarily unavailable. Your connection has not been removed.", true);
  }
}

byId("connectionPanel").addEventListener("submit", async event => {
  event.preventDefault();
  const button = byId("connectButton");
  button.disabled = true;
  byId("connectionStatus").textContent = "Checking connection…";
  try {
    const candidate = decodeConnectionCode(byId("connectionCode").value);
    const granted = await browserApi.permissions.request({ origins: [candidate.deployment + "/*"] });
    if (!granted) throw new Error("Deployment access was not granted.");
    const state = await loadCaptureState(candidate);
    connection = candidate;
    await browserApi.storage.local.set({ laterGatorConnection: connection });
    await presentCaptureState(state);
    byId("status").textContent = "";
  } catch (error) {
    byId("connectionStatus").textContent = error instanceof Error ? error.message : "Connection failed.";
  } finally {
    button.disabled = false;
  }
});

byId("connectionSettings").addEventListener("click", () => showConnection("", true));
byId("cancelConnection").addEventListener("click", showCapture);
byId("retryButton").addEventListener("click", () => {
  initialize().catch(() => showLoading("Later Gator is temporarily unavailable.", true));
});
byId("folder").addEventListener("change", syncFolderFields);
byId("tagInput").addEventListener("input", renderTagSuggestions);
byId("tagInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    const normalized = normalizeTag(byId("tagInput").value);
    if (byId("tagInput").value.trim().startsWith("#") && normalized !== "") {
      event.preventDefault();
      const existing = availableTags.find(
        tag => normalizeTag(tag.normalized_name || tag.display_name || "") === normalized,
      );
      addTag(normalized, existing?.display_name || normalized);
    }
  } else if (event.key === "Backspace" && byId("tagInput").value === "" && selectedTags.size > 0) {
    selectedTags.delete([...selectedTags.keys()].at(-1));
    renderSelectedTags();
  }
});
byId("linkedSearch").addEventListener("input", scheduleLinkedSearch);
byId("clearLinkedBookmark").addEventListener("click", () => clearLinkedBookmark(true));
byId("closeSuccess").addEventListener("click", () => window.close());
document.addEventListener("click", event => {
  if (!byId("tagFieldset").contains(event.target)) hideSuggestions("tagSuggestions", "tagInput");
  if (!byId("linkedFieldset").contains(event.target)) hideSuggestions("linkedSuggestions", "linkedSearch");
});

byId("captureForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = byId("saveButton");
  button.disabled = true;
  byId("status").textContent = "Saving…";
  try {
    const body = await request("/api/capture/bookmarks", {
      method: "POST",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        url: metadata.url || "",
        linkedUrl: selectedLinkedBookmark?.url ?? null,
        title: metadata.title || null,
        description: metadata.description || null,
        note: byId("note").value || null,
        folderId: byId("folder").value,
        tags: [...selectedTags.keys()],
        favorite: byId("favorite").checked,
        thumbnailUrl: metadata.image || null,
      }),
    });
    await updateSavedBadge(true);
    showSuccess(body.result);
  } catch (error) {
    if (isInvalidConnection(error)) {
      await discardConnection("This connection is no longer valid. Generate a fresh connection code in Settings.");
    } else {
      byId("status").textContent = "Failed: " + (error instanceof Error ? error.message : "Request failed");
    }
  } finally {
    button.disabled = false;
  }
});

initialize().catch(() => showLoading("Later Gator is temporarily unavailable.", true));
