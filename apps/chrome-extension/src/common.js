"use strict";

(() => {
  const SAVED_BADGE_COLOR = "#1d6fe0";

  /** Validates and normalizes a Later Gator deployment origin. */
  function connectionOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
      throw new Error("Enter an HTTPS Later Gator deployment URL.");
    }
    return url.origin;
  }

  /** Validates a stored extension connection and returns its normalized fields. */
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
      return {
        deployment: connectionOrigin(value.deployment),
        token: value.token,
        ...(typeof value.deviceId === "string" ? { deviceId: value.deviceId } : {}),
        ...(typeof value.deviceName === "string" ? { deviceName: value.deviceName } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Paints the saved-state badge and tooltip for one browser tab. */
  async function setSavedBadge(browserApi, tabId, saved) {
    await browserApi.action.setBadgeBackgroundColor({ color: SAVED_BADGE_COLOR, tabId });
    if (browserApi.action.setBadgeTextColor !== undefined) {
      await browserApi.action.setBadgeTextColor({ color: "#ffffff", tabId });
    }
    await browserApi.action.setBadgeText({ text: saved ? "✓" : "", tabId });
    await browserApi.action.setTitle({
      title: saved ? "Saved in Later Gator" : "Save to Later Gator",
      tabId,
    });
  }

  globalThis.laterGatorExtension = Object.freeze({
    connectionOrigin,
    storedConnection,
    setSavedBadge,
  });
})();
