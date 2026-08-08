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

    // Settings opens the shared how-to overlay at the panel it belongs to.
    document.querySelector<HTMLButtonElement>('[data-how-to="chrome"]')?.click();
    const dialog = document.querySelector<HTMLDialogElement>("#howToDialog");
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#howToTitle")?.textContent)
      .toBe("Save from Chrome");
    expect(document.querySelector('a[href="/extension/chrome"]')).toBeNull();
    document.querySelector<HTMLButtonElement>("#closeHowTo")?.click();
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
    // The maintained iCloud Shortcut replaced the "create one yourself" link.
    expect(document.querySelector<HTMLAnchorElement>('a[href^="https://www.icloud.com/shortcuts/"]'))
      .not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-how-to="ios"]')?.click();
    const dialog = document.querySelector<HTMLDialogElement>("#howToDialog");
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#howToTitle")?.textContent)
      .toBe("Save from your iPhone");
    document.querySelector<HTMLButtonElement>("#closeHowTo")?.click();

    document.querySelector<HTMLButtonElement>("#rotateMcp")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#mcpCredentialPanel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#copyMcpCredential")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(mcpUrl));
    document.querySelector<HTMLButtonElement>('[data-how-to="mcp"]')?.click();
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#howToTitle")?.textContent)
      .toBe("Connect ChatGPT or Claude");
    window.dispatchEvent(new Event("pagehide"));
  });
});

describe("provider form under the settings refresh poll", () => {
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

  it("keeps a typed model and a failed test result across refreshes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    const fetchCalls = () => calls;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      calls.push(requestPath(input));
      const path = requestPath(input);
      if (path.startsWith("/api/bootstrap")) return Promise.resolve(json({ state: settingsState() }));
      if (path.startsWith("/api/providers/test")) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: false,
          error: { code: "provider_test_invalid", message: "That model did not return the structured JSON Later Gator needs." },
        }), { status: 422, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(json({ ok: true }));
    }));

    await import("../src/main");
    const model = document.querySelector<HTMLInputElement>("#providerModel");
    const status = document.querySelector<HTMLElement>("#providerStatus");
    if (model === null || status === null) throw new Error("provider form missing");
    await vi.waitFor(() => expect(model.value).toBe("test-model"));

    model.value = "@cf/nvidia/nemotron-3-120b-a12b";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLFormElement>("#providerForm")?.requestSubmit();
    await vi.waitFor(() => expect(status.className).toBe("status error"));
    const failureText = status.textContent;

    // Drive the real 5s settings poll three times over. It used to overwrite
    // the model box mid-edit and replace the failure with a stale "ready".
    const refreshes = fetchCalls().filter(path => path.startsWith("/api/bootstrap")).length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchCalls().filter(path => path.startsWith("/api/bootstrap")).length)
      .toBeGreaterThan(refreshes);
    expect(model.value).toBe("@cf/nvidia/nemotron-3-120b-a12b");
    expect(status.textContent).toBe(failureText);
    expect(status.className).toBe("status error");

    // The owner can still correct the value.
    model.value = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.value).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    window.dispatchEvent(new Event("pagehide"));
    vi.useRealTimers();
  });
});
