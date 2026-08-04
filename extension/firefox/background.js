"use strict";

const browserApi = globalThis.browser ?? globalThis.chrome;

function storedConnection(value) {
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
    const deployment = new URL(value.deployment);
    if (
      deployment.protocol !== "https:" &&
      !(deployment.protocol === "http:" && deployment.hostname === "localhost")
    ) {
      return null;
    }
    return { deployment: deployment.origin, token: value.token };
  } catch {
    return null;
  }
}

async function setSavedBadge(tabId, saved) {
  await browserApi.action.setBadgeBackgroundColor({ color: "#2f7d4f", tabId });
  await browserApi.action.setBadgeText({ text: saved ? "✓" : "", tabId });
  await browserApi.action.setTitle({
    title: saved ? "Saved in Later Gator" : "Save to Later Gator",
    tabId,
  });
}

async function refreshTab(tab) {
  if (typeof tab?.id !== "number") return;
  if (typeof tab.url !== "string" || !/^https?:\/\//u.test(tab.url)) {
    await setSavedBadge(tab.id, false);
    return;
  }
  const stored = await browserApi.storage.local.get("laterGatorConnection");
  const connection = storedConnection(stored.laterGatorConnection);
  if (connection === null) {
    await setSavedBadge(tab.id, false);
    return;
  }
  const permitted = await browserApi.permissions.contains({
    origins: [connection.deployment + "/*"],
  });
  if (!permitted) {
    await setSavedBadge(tab.id, false);
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
    await setSavedBadge(tab.id, response.ok && body?.saved === true);
  } catch {
    await setSavedBadge(tab.id, false);
  }
}

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
