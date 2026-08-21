import { beforeEach, describe, expect, it, vi } from "vitest";
import chromeManifestRaw from "../manifest.json?raw";

const deployment = "https://later-gator.example.workers.dev";
const token = "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";

function eventMock() {
  return { addListener: vi.fn() };
}

describe("extension saved-page background indicator", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("checks the active page on startup and overlays a tick when it is saved", async () => {
    const browser = {
      permissions: { contains: vi.fn().mockResolvedValue(true) },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            laterGatorConnection: { deployment, token },
          }),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{
          id: 7,
          url: "https://example.com/already-saved",
        }]),
        onActivated: eventMock(),
        onUpdated: eventMock(),
      },
      runtime: {
        onStartup: eventMock(),
        onInstalled: eventMock(),
      },
      action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setTitle: vi.fn().mockResolvedValue(undefined),
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, saved: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", fetchMock);

    // @ts-expect-error The shipped WebExtension background script is intentionally plain JavaScript.
    await import("../src/common.js");
    // @ts-expect-error The shipped WebExtension background script is intentionally plain JavaScript.
    await import("../src/background.js");

    await vi.waitFor(() => {
      expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "✓", tabId: 7 });
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = init?.body;
    if (typeof requestBody !== "string") throw new Error("Saved status request body is missing");
    expect(JSON.parse(requestBody)).toEqual({
      url: "https://example.com/already-saved",
    });
  });

  it("declares identity and only the bounded managed-runtime host ceiling", () => {
    const manifest = JSON.parse(chromeManifestRaw) as {
      permissions: string[];
      optional_host_permissions?: string[];
      background?: { service_worker?: string };
    };
    expect(manifest.permissions).toContain("tabs");
    expect(manifest.permissions).toContain("identity");
    expect(manifest.optional_host_permissions).toEqual([
      "https://*.workers.dev/*",
      "http://localhost/*",
    ]);
    expect(manifest.optional_host_permissions).not.toContain("https://*/*");
    expect(manifest.background?.service_worker).toBe("background.js");
  });
});
