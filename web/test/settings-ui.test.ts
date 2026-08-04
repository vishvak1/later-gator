import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPage } from "../../src/v6/routes/pages";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function settingsState() {
  return {
    setupStatus: "complete",
    ownerAiPaused: false,
    personalInstructions: null,
    activeImport: null,
    folders: [],
    tags: [],
    sites: [],
    trashCount: 0,
    automationProgress: {
      total: 0,
      complete: 0,
      pending: 0,
      processing: 0,
      waitingProvider: 0,
      pausedOwner: 0,
      review: 0,
      failed: 0,
      lastActivityAt: null,
    },
    provider: {
      provider: "workers-ai",
      model: "test-model",
      operational_status: "ready",
      last_safe_error_code: null,
    },
  };
}

describe("settings navigation lifecycle", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const html = await settingsPage().text();
    const body = /<body[^>]*>([\s\S]*?)<script type="module"/u.exec(html)?.[1];
    if (body === undefined) throw new Error("Settings page body was not rendered");
    document.body.dataset.page = "settings";
    document.body.innerHTML = body;
  });

  it("does not report an aborted refresh after navigation begins", async () => {
    let rejectBootstrap: ((reason: Error) => void) | undefined;
    const bootstrapRequest = new Promise<Response>((_resolve, reject) => {
      rejectBootstrap = reject;
    });
    const fetchMock = vi.fn(() => bootstrapRequest);
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    window.dispatchEvent(new Event("pagehide"));
    rejectBootstrap?.(new TypeError("NetworkError when attempting to fetch resource"));
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(document.querySelector("#providerStatus")?.textContent).not.toContain(
      "Settings could not refresh",
    );
  });

  it("renders editable AI instructions and both direct import modes", () => {
    expect(document.querySelector("#personalInstructionsForm")).not.toBeNull();
    expect(document.querySelector("#settingsPersonalInstructions")).not.toBeNull();
    const options = [...document.querySelectorAll<HTMLOptionElement>("#importOption option")]
      .map(option => option.value);
    expect(options).toEqual(["reorganize", "preserve"]);
    expect(document.querySelectorAll("[data-theme-choice]")).toHaveLength(3);
    expect(document.querySelector(".topbar [data-theme-choice]")).toBeNull();
  });

  it("generates one copyable extension code and opens setup in a dialog", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: settingsState() }));
      if (path === "/api/capture/credentials") {
        return Promise.resolve(json({ credential: { token } }));
      }
      throw new Error("Unexpected request: " + path);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await import("../src/main");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    document.querySelector<HTMLButtonElement>('[data-extension-guide="chrome"]')?.click();
    const dialog = document.querySelector<HTMLDialogElement>("#extensionGuideDialog");
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#chromeExtensionGuide")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#firefoxExtensionGuide")?.hidden).toBe(true);
    expect(document.querySelector('a[href="/extension/chrome"]')).toBeNull();
    document.querySelector<HTMLButtonElement>("#closeExtensionGuide")?.click();
    expect(dialog?.open).toBe(false);

    document.querySelector<HTMLButtonElement>("#pairExtension")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("#extensionCredential")?.textContent)
        .toMatch(/^later-gator-v1\./u);
    });
    const code = document.querySelector("#extensionCredential")?.textContent ?? "";
    expect(code).not.toContain(location.origin);
    expect(code).not.toContain(token);
    document.querySelector<HTMLButtonElement>("#copyExtensionCredential")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    expect(document.querySelector("#extensionCredentialStatus")?.textContent).toBe(
      "Connection code copied.",
    );
    expect(document.querySelector("#extensionName")).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
  });

  it("reveals copyable iOS and MCP secrets and opens their tutorials in a dialog", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";
    const mcpUrl = "https://later-gator.test/mcp/one-time-secret";
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: settingsState() }));
      if (path === "/api/capture/credentials") {
        return Promise.resolve(json({ credential: { token } }));
      }
      if (path === "/api/mcp/rotate") return Promise.resolve(json({ url: mcpUrl }));
      throw new Error("Unexpected request: " + path);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await import("../src/main");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    document.querySelector<HTMLButtonElement>("#pairIos")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#iosCredentialPanel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#copyIosEndpoint")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(
      location.origin + "/api/capture/ios",
    ));
    document.querySelector<HTMLButtonElement>("#copyIosToken")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
    expect(document.querySelector<HTMLAnchorElement>('a[href="shortcuts://create-shortcut"]'))
      .not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-connection-guide="ios"]')?.click();
    const dialog = document.querySelector<HTMLDialogElement>("#connectionGuideDialog");
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#iosConnectionGuide")?.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>("#closeConnectionGuide")?.click();

    document.querySelector<HTMLButtonElement>("#rotateMcp")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#mcpCredentialPanel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#copyMcpCredential")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(mcpUrl));
    document.querySelector<HTMLButtonElement>('[data-connection-guide="mcp"]')?.click();
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#mcpConnectionGuide")?.hidden).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
  });
});
