"use strict";

if (globalThis.laterGatorExtension === undefined && typeof importScripts === "function") {
  importScripts("common.js");
}

const browserApi = globalThis.browser ?? globalThis.chrome;
const { setSavedBadge, storedConnection } = globalThis.laterGatorExtension;

/** Queries Later Gator for one tab URL and refreshes that tab's saved badge. */
async function refreshTab(tab) {
  if (typeof tab?.id !== "number") return;
  if (typeof tab.url !== "string" || !/^https?:\/\//u.test(tab.url)) {
    await setSavedBadge(browserApi, tab.id, false);
    return;
  }
  const stored = await browserApi.storage.local.get("laterGatorConnection");
  const connection = storedConnection(stored.laterGatorConnection);
  if (connection === null) {
    await setSavedBadge(browserApi, tab.id, false);
    return;
  }
  const permitted = await browserApi.permissions.contains({
    origins: [connection.deployment + "/*"],
  });
  if (!permitted) {
    await setSavedBadge(browserApi, tab.id, false);
    return;
  }
  try {
    const response = await fetch(connection.deployment + "/api/capture/bookmark-status", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: tab.url }),
    });
    const body = await response.json();
    await setSavedBadge(browserApi, tab.id, response.ok && body?.saved === true);
  } catch {
    await setSavedBadge(browserApi, tab.id, false);
  }
}

/** Finds the active tab and synchronizes its saved badge when it has a web URL. */
async function refreshActiveTab() {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  await refreshTab(tab);
}

browserApi.tabs.onActivated.addListener(() => {
  refreshActiveTab().catch(() => undefined);
});
browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined && changeInfo.status !== "complete") return;
  browserApi.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id === tabId) return refreshTab(tab);
    return undefined;
  }).catch(() => undefined);
});
browserApi.runtime.onStartup.addListener(() => {
  refreshActiveTab().catch(() => undefined);
});
browserApi.runtime.onInstalled.addListener(() => {
  refreshActiveTab().catch(() => undefined);
});

refreshActiveTab().catch(() => undefined);
