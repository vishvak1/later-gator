"use strict";

const browserApi = globalThis.browser ?? globalThis.chrome;
const { connectionOrigin, setSavedBadge, storedConnection } = globalThis.laterGatorExtension;
const controlPlaneOrigin = globalThis.laterGatorExtensionConfig?.controlPlaneOrigin || "https://latergator.app";
let connection = null;
let metadata = {};
let availableTags = [];
let unsortedFolderIds = new Set(["folder_unsorted"]);
let selectedTags = new Map();
let selectedLinkedBookmark = null;
let linkedSearchTimer = null;
let linkedSearchGeneration = 0;
let pendingCapturePayload = null;

class CaptureRequestError extends Error {
  constructor(message, status, code = "request_failed", details = null) {
    super(message);
    this.name = "CaptureRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Returns the popup element with the requested ID. */
const byId = id => document.getElementById(id);

/** Shows view for the extension popup. */
function showView(view) {
  byId("loadingPanel").hidden = view !== "loading";
  byId("connectionPanel").hidden = view !== "connection";
  byId("captureForm").hidden = view !== "capture";
  byId("duplicatePanel").hidden = view !== "duplicate";
  byId("successPanel").hidden = view !== "success";
  byId("connectionSettings").hidden = view !== "capture";
  byId("popupHeader").hidden = view === "success";
}

/** Shows loading for the extension popup. */
function showLoading(message = "Connecting to Later Gator…", retry = false) {
  byId("loadingStatus").textContent = message;
  byId("retryButton").hidden = !retry;
  showView("loading");
}

/** Shows connection for the extension popup. */
function showConnection(message = "", canCancel = false) {
  if (byId("deviceName").value === "") {
    byId("deviceName").value = `Chrome on ${navigator.platform || "this device"}`;
  }
  byId("connectionStatus").textContent = message;
  byId("cancelConnection").hidden = !canCancel;
  showView("connection");
}

/** Creates one URL-safe state value for the Chrome identity round trip. */
function oauthState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Connects through Cloudflare identity and exchanges a one-time pairing grant. */
async function connectWithCloudflare() {
  const storedDevice = await browserApi.storage.local.get("laterGatorDeviceId");
  const deviceId = typeof storedDevice.laterGatorDeviceId === "string"
    ? storedDevice.laterGatorDeviceId
    : crypto.randomUUID();
  const deviceName = byId("deviceName").value.trim();
  if (deviceName === "") throw new Error("Name this Chrome device first.");
  const state = oauthState();
  const redirectUri = browserApi.identity.getRedirectURL("cloudflare");
  const authorization = new URL("/extension/connect", controlPlaneOrigin);
  authorization.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    device_id: deviceId,
    device_name: deviceName,
  }).toString();
  let callback;
  try {
    callback = await browserApi.identity.launchWebAuthFlow({
      url: authorization.toString(),
      interactive: true,
    });
  } catch {
    throw new Error("Cloudflare sign-in was cancelled or could not finish.");
  }
  if (typeof callback !== "string") throw new Error("Cloudflare sign-in did not return.");
  const result = new URL(callback);
  if (result.origin + result.pathname !== new URL(redirectUri).origin + new URL(redirectUri).pathname) {
    throw new Error("Cloudflare returned to an unexpected address.");
  }
  if (result.searchParams.get("state") !== state) throw new Error("Cloudflare connection state did not match.");
  if (result.searchParams.get("device_id") !== deviceId) throw new Error("Cloudflare returned another device.");
  const deployment = connectionOrigin(result.searchParams.get("deployment") || "");
  const grant = result.searchParams.get("grant");
  if (grant === null || grant.length < 32 || grant.length > 8192) {
    throw new Error("The one-time connection grant was incomplete.");
  }
  const granted = await browserApi.permissions.request({ origins: [deployment + "/*"] });
  if (!granted) throw new Error("Access to your personal Later Gator was not granted.");
  const response = await fetch(deployment + "/api/capture/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant, deviceId, deviceName }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.credential?.token !== "string") {
    throw new Error(body?.error?.message || "The one-time connection could not be exchanged.");
  }
  return { deployment, token: body.credential.token, deviceId, deviceName };
}

/** Shows capture for the extension popup. */
function showCapture() {
  showView("capture");
}

/** Shows success for the extension popup. */
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

/** Updates saved badge for the extension popup. */
async function updateSavedBadge(saved) {
  const tabId = metadata.tabId;
  if (typeof tabId !== "number" || browserApi.action === undefined) return;
  try {
    await setSavedBadge(browserApi, tabId, saved);
  } catch {
    // Saving remains available if a browser does not support per-tab action badges.
  }
}

/** Sends an authenticated deployment request and classifies connection failures. */
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
    throw new CaptureRequestError(
      body?.error?.message || "Request failed",
      response.status,
      body?.error?.code || "request_failed",
      body,
    );
  }
  if (body === null) throw new CaptureRequestError("The deployment returned an invalid response.", 404);
  return body;
}

/** Sends an authenticated request using the currently validated connection. */
function request(path, options = {}) {
  if (connection === null) throw new CaptureRequestError("Reconnect Later Gator.", 401);
  return requestWith(connection, path, options);
}

/** Reports whether an error means the stored connection must be discarded. */
function isInvalidConnection(error) {
  return error instanceof CaptureRequestError && [400, 401, 403, 404, 405].includes(error.status);
}

/** Extracts bounded title, description, image, and thread links from the active tab. */
async function pageMetadata() {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return {};
  let page = {};
  try {
    const results = await browserApi.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        /** Reads a metadata element from the active browser page. */
        const meta = name =>
          document.querySelector(`meta[property="${name}"]`)?.content ||
          document.querySelector(`meta[name="${name}"]`)?.content ||
          "";
        /** Normalizes a hostname for same-page metadata checks. */
        const host = value => value.replace(/^www\./iu, "").toLowerCase();
        /*
         * True when `declared` describes the page now at `current`. A canonical
         * URL is allowed to be a prefix of the real one: sites publish
         * `?v=abc` while the address bar carries `?v=abc&si=…&t=30`. So every
         * parameter the canonical URL names must match, and extra tracking
         * parameters on the current URL are ignored rather than treated as a
         * different page.
         */
        /** Reports whether two URLs identify the same normalized page. */
        const describesSamePage = (declared, current) => {
          try {
            const a = new URL(declared);
            const b = new URL(current);
            if (host(a.hostname) !== host(b.hostname)) return false;
            if (a.pathname.replace(/\/$/u, "") !== b.pathname.replace(/\/$/u, "")) return false;
            for (const [key, value] of a.searchParams) {
              if (b.searchParams.get(key) !== value) return false;
            }
            return true;
          } catch {
            return false;
          }
        };
        /*
         * og:* and description tags are rendered once, with the document. A site
         * that routes client-side — x.com, Instagram, YouTube, Reddit — changes
         * location without rewriting them, so they can still describe whichever
         * page happened to load first. Reading them then attaches the previously
         * opened link's thumbnail to this bookmark.
         *
         * og:url is the reliable signal, because it says which page the rest of
         * the og block is about: if it names this page the tags are current, and
         * if it names another page they are stale, whichever way we arrived.
         * Only when a page publishes no og:url do we fall back to asking whether
         * the document has been routed somewhere else since it loaded.
         */
        const declared = meta("og:url");
        let stale;
        if (declared !== "") {
          stale = !describesSamePage(declared, location.href);
        } else {
          const navigated = performance.getEntriesByType("navigation")[0]?.name;
          stale =
            typeof navigated === "string" &&
            navigated !== "" &&
            !describesSamePage(navigated, location.href) &&
            !describesSamePage(location.href, navigated);
        }

        /*
         * YouTube publishes every cover at a fixed path built from the video id,
         * so on a watch page the id in the address bar is a better source than
         * any tag: it is right even when the whole og block belongs to the feed
         * the video was opened from.
         */
        /** Derives a stable YouTube cover image URL when the page is a video. */
        const youTubeCover = () => {
          try {
            const url = new URL(location.href);
            const site = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./u, "");
            let id = null;
            if (site === "youtu.be") id = url.pathname.slice(1).split("/")[0];
            else if (site === "youtube.com" || site === "youtube-nocookie.com") {
              id = url.searchParams.get("v")
                || (/^\/(?:shorts|embed|live)\/([^/?#]+)/u.exec(url.pathname) || [])[1]
                || null;
            }
            return id && /^[A-Za-z0-9_-]{6,20}$/u.test(id)
              ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
              : "";
          } catch {
            return "";
          }
        };

        /*
         * The rendered document, unlike the head, cannot be stale: a page that
         * routed somewhere else replaced its content to get there. So when the
         * tags describe the wrong page, the biggest image actually on screen is
         * still this page's — that is what recovers a cover on Reddit and on
         * other apps that never rewrite their og tags.
         */
        /** Selects the largest visible content image after excluding UI chrome. */
        const largestVisibleImage = () => {
          let best = null;
          let bestArea = 0;
          for (const image of document.images) {
            const source = image.currentSrc || image.src || "";
            if (!/^https?:/iu.test(source)) continue;
            const box = image.getBoundingClientRect();
            // Rendered size, so layout decides what is prominent rather than the
            // intrinsic size of a sprite sheet or a tracking pixel.
            const area = Math.min(box.width, 1600) * Math.min(box.height, 1600);
            if (box.width < 160 || box.height < 120) continue;
            if (image.closest("nav, header, footer, aside") !== null) continue;
            if (area > bestArea) {
              bestArea = area;
              best = source;
            }
          }
          return best ?? "";
        };

        const trustedImage = stale ? "" : meta("og:image") || meta("twitter:image");
        const image = youTubeCover() || trustedImage || (stale ? largestVisibleImage() : "");
        return {
          // Nothing is better than the wrong picture: with no candidate left the
          // deployment renders the page itself for the thumbnail.
          description: stale ? "" : meta("description") || meta("og:description"),
          image,
          staleMetadata: stale,
        };
      },
    });
    page = results[0]?.result || {};
  } catch {
    // URL and tab title remain useful when a page does not allow script injection.
  }
  const merged = { tabId: tab.id, url: tab.url, title: tab.title || "", ...page };
  /*
   * Recovers a YouTube cover from the tab URL alone, without reading the page.
   * That matters where injection is unavailable — a page that forbids it, and
   * browsers whose scripting API does not support passing a function — because
   * there the whole metadata read yields nothing and every cover goes missing.
   */
  if (!merged.image) {
    const derived = youTubeCoverFor(tab.url);
    if (derived !== "") merged.image = derived;
  }
  return merged;
}

/**
 * Reads the outbound links an X post points at, including the ones the author
 * put in their own reply.
 *
 * Two reasons this can only be done here, in the page:
 *
 * A long post — the kind with "Show more" — is only ever published in truncated
 * form: oEmbed and the syndication endpoint both stop around 280 characters and
 * expose no `urls` entities, so a link past that point is invisible to the
 * deployment however it asks. And replies are not published at all — the
 * syndication endpoint returns a `conversation_count` and nothing else, the old
 * conversation endpoints return empty, and the official API needs a paid key.
 * The rendered page is the only place either can still be read.
 *
 * Deliberately read at save time rather than when the popup opens: X loads the
 * focal post first and fills in replies afterwards, so asking immediately is
 * asking at the one moment they are reliably absent. By the time Save is
 * pressed the page has had the whole life of the popup to settle.
 *
 * Links stay in t.co form. Only the deployment can follow one, and it already
 * discards the ones leading back into X — a post's own photo is published as a
 * t.co link exactly like an outbound one.
 */
async function readPostLinks(tabId) {
  if (typeof tabId !== "number") return [];
  try {
    const results = await browserApi.scripting.executeScript({
      target: { tabId },
      func: () => {
        const site = location.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./u, "");
        if (site !== "x.com" && site !== "twitter.com") return [];
        const path = location.pathname.split("/");
        if (!/\/status(?:es)?\/\d+/u.test(location.pathname)) return [];
        /*
         * Whose post this is, taken from the address rather than from the first
         * rendered article. On a page scrolled down into the replies the first
         * article is somebody else's, and trusting it would attribute a
         * stranger's links to this bookmark.
         */
        const owner = (path[1] ?? "").toLowerCase();
        if (owner === "") return [];
        /** Extracts an author handle from a supported social-post URL. */
        const authorOf = post => {
          const link = post.querySelector('[data-testid="User-Name"] a[href^="/"]');
          if (link === null) return null;
          return (new URL(link.href).pathname.split("/")[1] ?? "").toLowerCase();
        };
        const found = [];
        /*
         * Take links from the author's own posts among the first few articles:
         * the post itself and any self-reply continuing it.
         *
         * Scanning a short window rather than stopping at the first article by
         * someone else, because replies are ranked rather than chronological —
         * X can place a popular stranger's reply above the author's own
         * continuation, and stopping there would miss the very link this looks
         * for. The window is what keeps it from wandering into the author
         * reappearing far down the thread on an unrelated tangent.
         */
        const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 5);
        const seen = new Set();
        for (const post of articles) {
          if (authorOf(post) !== owner) continue;
          for (const anchor of post.querySelectorAll('a[href^="https://t.co/"]')) {
            // X renders the same link twice, as body text and as its card.
            if (seen.has(anchor.href)) continue;
            seen.add(anchor.href);
            /*
             * The address is a t.co shortener, which tells the owner nothing
             * about where it goes. X prints the real destination as the link's
             * own text, so that is what gets carried alongside it and shown.
             */
            const label = (anchor.textContent ?? "").replace(/\s+/gu, "").trim();
            found.push({ url: anchor.href, label: label === "" ? anchor.href : label });
            if (found.length >= 4) return found;
          }
        }
        return found;
      },
    });
    const value = results?.[0]?.result;
    /*
     * Must be a list of well-formed entries whatever came back. A browser that
     * answers an injection with an unexpected shape would otherwise reach the
     * request body and throw, and this runs inside submit — so a surprise here
     * would fail the save itself rather than merely cost a link.
     */
    if (!Array.isArray(value)) return [];
    return value
      .filter(link => link !== null && typeof link === "object" && typeof link.url === "string")
      .map(link => ({
        url: link.url,
        label: typeof link.label === "string" && link.label !== "" ? link.label : link.url,
      }));
  } catch {
    // A page that refuses injection simply contributes no links.
    return [];
  }
}

/** Kept in step with the copy injected into the page, which cannot see this one. */
function youTubeCoverFor(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const site = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./u, "");
    let id = null;
    if (site === "youtu.be") id = url.pathname.slice(1).split("/")[0];
    else if (site === "youtube.com" || site === "youtube-nocookie.com") {
      id = url.searchParams.get("v")
        || (/^\/(?:shorts|embed|live)\/([^/?#]+)/u.exec(url.pathname) || [])[1]
        || null;
    }
    return id && /^[A-Za-z0-9_-]{6,20}$/u.test(id)
      ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
      : "";
  } catch {
    return "";
  }
}

/** Normalizes tag for the extension popup. */
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

/** Hides suggestions for the extension popup. */
function hideSuggestions(id, inputId) {
  byId(id).hidden = true;
  byId(id).replaceChildren();
  byId(inputId).setAttribute("aria-expanded", "false");
}

/** Creates one accessible autocomplete option button with its selection callback. */
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

/** Renders selected tags for the extension popup. */
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

/** Adds a normalized tag chip when it is allowed and not already selected. */
function addTag(normalized, display = normalized) {
  if (normalized === "" || selectedTags.size >= 50) return;
  selectedTags.set(normalized, display);
  renderSelectedTags();
  byId("tagInput").value = "";
  byId("tagHelp").textContent = "Type # to choose an existing tag or create a new one.";
  hideSuggestions("tagSuggestions", "tagInput");
}

/** Renders tag suggestions for the extension popup. */
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

/** Clears linked bookmark for the extension popup. */
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

/** Selects linked bookmark for the extension popup. */
function selectLinkedBookmark(bookmark) {
  selectedLinkedBookmark = bookmark;
  byId("selectedLinkedLabel").textContent = bookmark.title || bookmark.url;
  byId("selectedLinkedBookmark").hidden = false;
  byId("linkedSearch").hidden = true;
  byId("linkedHelp").textContent = `${bookmark.hostname || "Bookmark"} · ${bookmark.folder_name || "Later Gator"}`;
  hideSuggestions("linkedSuggestions", "linkedSearch");
}

/** Renders linked suggestions for the extension popup. */
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

/** Schedules linked search for the extension popup. */
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

/** Synchronizes folder fields for the extension popup. */
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

/** Populates options for the extension popup. */
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

/**
 * An <img> keeps painting its previous frame until a new src finishes decoding,
 * so assigning a new URL and unhiding in the same tick can show the last
 * bookmark's picture for as long as the fetch takes. Clearing the element first
 * and only revealing it on load means it shows this page's image or nothing.
 */
/**
 * Paints the page's cover into the header tile.
 *
 * The tile is always occupied, never hidden: it is the same slot the mark sits
 * in, so hiding it would make the header jump. A page with no usable cover, and
 * a cover whose host refuses to serve it to another origin — Reddit's image CDN
 * rejects hotlinks often enough that this is common — both fall back to the
 * mark, which is why there is no longer a second, larger copy of the picture
 * below. The deployment still renders its own thumbnail after saving.
 */
function showPreview(imageUrl) {
  const preview = byId("preview");
  preview.onload = null;
  preview.onerror = null;

  /** Shows fallback for the extension popup. */
  const showFallback = () => {
    preview.onload = null;
    preview.onerror = null;
    preview.classList.add("placeholder");
    preview.src = "icons/icon-48.png";
  };

  if (!imageUrl) {
    showFallback();
    return;
  }
  preview.onload = () => { preview.classList.remove("placeholder"); };
  preview.onerror = showFallback;
  preview.src = imageUrl;
}

/** Prepares capture for the extension popup. */
async function prepareCapture(options, activePage = null) {
  metadata = activePage ?? await pageMetadata().catch(() => ({}));
  selectedTags = new Map();
  clearLinkedBookmark();
  byId("pageTitle").textContent = metadata.title || "Current page";
  byId("pageDescription").textContent = metadata.description || "";
  showPreview(metadata.image);
  fillOptions(options);
  void showThreadLinks();
}

/**
 * Says, before saving, which links in the thread will be saved alongside this
 * post. Without it the feature is invisible: an X post that quietly failed to
 * pick up its author's link looked exactly like one that had no link to pick
 * up, and neither the owner nor a bug report could tell the two apart.
 *
 * The same controls are the submission source, so the saved set cannot drift
 * after the owner has made individual choices.
 */
async function showThreadLinks() {
  const note = byId("threadLinks");
  const popover = byId("threadLinksPopover");
  note.hidden = true;
  popover.replaceChildren();
  const links = await readPostLinks(metadata.tabId);
  if (links.length === 0) return;
  byId("threadLinksLabel").textContent = links.length === 1
    ? "1 link in this thread will be saved too."
    : `${links.length} links in this thread will be saved too.`;
  // Built as nodes rather than markup: these strings come off a page, and the
  // popup would otherwise be interpreting whatever a post chose to put there.
  for (const link of links) {
    const item = document.createElement("li");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.postLink = link.url;
    checkbox.setAttribute("aria-label", `Save ${link.label}`);
    const label = document.createElement("span");
    label.textContent = link.label;
    label.title = link.label;
    item.append(checkbox, label);
    popover.append(item);
  }
  byId("threadLinksToggle").checked = true;
  note.hidden = false;
}

/** Returns only links individually selected under the master X-link control. */
function selectedPostLinks() {
  if (!(byId("threadLinksToggle")?.checked ?? true)) return [];
  return [...byId("threadLinksPopover").querySelectorAll("input[data-post-link]:checked")]
    .map(input => input.dataset.postLink)
    .filter(value => typeof value === "string")
    .slice(0, 4);
}

/** Shows the non-mutating duplicate decision returned by the Worker. */
function showDuplicateDecision(error) {
  const duplicates = Array.isArray(error.details?.duplicates) ? error.details.duplicates : [];
  byId("duplicateLinks").replaceChildren(...duplicates.map(duplicate => {
    const item = document.createElement("li");
    item.textContent = duplicate.title || duplicate.hostname || "Existing bookmark";
    item.title = duplicate.url || item.textContent;
    return item;
  }));
  byId("duplicateStatus").textContent = "";
  showView("duplicate");
}

/** Sends one capture payload and advances to success only after a committed save. */
async function submitCapture(payload) {
  const body = await request("/api/capture/bookmarks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await updateSavedBadge(true);
  pendingCapturePayload = null;
  showSuccess(body.result);
}

/** Loads capture state for the extension popup. */
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

/** Presents capture state for the extension popup. */
async function presentCaptureState(state) {
  await prepareCapture(state.options, state.activePage);
  await updateSavedBadge(state.saved);
  if (state.saved) showSuccess("already_saved");
  else showCapture();
}

/** Discards connection for the extension popup. */
async function discardConnection(message) {
  connection = null;
  await browserApi.storage.local.remove("laterGatorConnection");
  showConnection(message);
}

/** Initializes ialize for the extension popup. */
async function initialize() {
  showLoading();
  const stored = await browserApi.storage.local.get("laterGatorConnection");
  connection = storedConnection(stored.laterGatorConnection) ?? null;
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
      await discardConnection("This connection is no longer valid. Continue with Cloudflare to reconnect.");
      return;
    }
    showLoading("Later Gator is temporarily unavailable. Your connection has not been removed.", true);
  }
}

byId("connectButton").addEventListener("click", async () => {
  const button = byId("connectButton");
  button.disabled = true;
  byId("connectionStatus").textContent = "Opening Cloudflare…";
  try {
    const candidate = await connectWithCloudflare();
    const state = await loadCaptureState(candidate);
    connection = candidate;
    await browserApi.storage.local.set({
      laterGatorConnection: connection,
      laterGatorDeviceId: candidate.deviceId,
    });
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
byId("backFromDuplicate").addEventListener("click", showCapture);
byId("cancelDuplicate").addEventListener("click", () => window.close());
byId("confirmDuplicate").addEventListener("click", async () => {
  if (pendingCapturePayload === null) return showCapture();
  const button = byId("confirmDuplicate");
  button.disabled = true;
  byId("duplicateStatus").textContent = "Saving…";
  try {
    await submitCapture({
      ...pendingCapturePayload,
      requestId: crypto.randomUUID(),
      acceptExistingPostLinks: true,
    });
  } catch (error) {
    byId("duplicateStatus").textContent = error instanceof Error ? error.message : "Request failed";
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("click", event => {
  if (!byId("tagFieldset").contains(event.target)) hideSuggestions("tagSuggestions", "tagInput");
  if (!byId("linkedFieldset").contains(event.target)) hideSuggestions("linkedSuggestions", "linkedSearch");
});

byId("captureForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = byId("saveButton");
  const label = button.textContent;
  // The button says what it is doing, so the status line no longer has to hold
  // a row of empty space open underneath just to announce it.
  button.disabled = true;
  button.textContent = "Saving…";
  byId("status").textContent = "";
  try {
    const payload = {
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
        /*
         * The checkbox is the owner's veto over links they can see listed.
         * Read defensively: this runs inside submit, so a missing control must
         * cost a link at worst, never the bookmark.
         */
        postLinks: selectedPostLinks(),
      };
    pendingCapturePayload = payload;
    await submitCapture(payload);
  } catch (error) {
    if (error instanceof CaptureRequestError && error.code === "x_destination_already_saved") {
      showDuplicateDecision(error);
      return;
    }
    if (isInvalidConnection(error)) {
      await discardConnection("This connection is no longer valid. Continue with Cloudflare to reconnect.");
    } else {
      byId("status").textContent = "Failed: " + (error instanceof Error ? error.message : "Request failed");
    }
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

initialize().catch(() => showLoading("Later Gator is temporarily unavailable.", true));
