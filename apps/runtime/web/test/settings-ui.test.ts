import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPage } from "../../src/routes/pages";

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

function thumbnailStorageState(overrides: Record<string, unknown> = {}) {
  return {
    byteSize: 4096,
    migrationId: null,
    migrationState: null,
    mode: "kv",
    objectCount: 4,
    safeErrorCode: null,
    status: "ready",
    ...overrides,
  };
}

function catalogState() {
  return {
    models: {
      revision: 1,
      publishedAt: "2026-08-21T00:00:00.000Z",
      models: [
        { provider: "cloudflare", modelId: "test-model", displayName: "Test model", isDefault: false, deprecatedAfter: null, minimumRuntimeRelease: "1.0.0" },
        { provider: "cloudflare", modelId: "@cf/nvidia/nemotron-3-120b-a12b", displayName: "Nemotron 3", isDefault: false, deprecatedAfter: null, minimumRuntimeRelease: "1.0.0" },
        { provider: "cloudflare", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", displayName: "Llama 3.3", isDefault: true, deprecatedAfter: null, minimumRuntimeRelease: "1.0.0" },
      ],
    },
    storagePlans: {
      reviewedOn: "2026-08-21",
      disclaimer: "Allowances may change.",
      plans: [
        { storageVariant: "kv", title: "Workers KV", summary: "KV summary", billingProfileMayBeRequired: false, informationalAllowances: ["1 GB"], officialUrls: ["https://developers.cloudflare.com/kv/platform/pricing/"] },
        { storageVariant: "r2", title: "R2", summary: "R2 summary", billingProfileMayBeRequired: true, informationalAllowances: ["10 GB-month"], officialUrls: ["https://developers.cloudflare.com/r2/pricing/"] },
        { storageVariant: "disabled", title: "Disabled", summary: "No thumbnails", billingProfileMayBeRequired: false, informationalAllowances: [], officialUrls: ["https://developers.cloudflare.com/workers/"] },
      ],
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

  it("manages thumbnail storage without deleting bookmarks implicitly", async () => {
    let storage = thumbnailStorageState();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: settingsState() }));
      if (path === "/api/mcp/connections") {
        return Promise.resolve(json({ endpoint: location.origin + "/mcp", connections: [] }));
      }
      if (path === "/api/storage/thumbnails" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(json({ storage }));
      }
      if (path === "/api/catalogs") return Promise.resolve(json({ catalogs: catalogState() }));
      if (path === "/api/capture/devices") return Promise.resolve(json({ devices: [] }));
      if (path === "/api/storage/thumbnails/disable" && init?.method === "POST") {
        storage = thumbnailStorageState({ mode: "disabled", safeErrorCode: "thumbnail_storage_disabled" });
        return Promise.resolve(json({ ok: true, storage }));
      }
      if (path === "/api/storage/thumbnails/enable-kv" && init?.method === "POST") {
        storage = thumbnailStorageState();
        return Promise.resolve(json({ ok: true, storage }));
      }
      if (path === "/api/storage/thumbnails/migrate-r2" && init?.method === "POST") {
        storage = thumbnailStorageState({
          migrationId: "11111111-1111-4111-8111-111111111111",
          migrationState: "copying",
          status: "migrating",
        });
        return Promise.resolve(json({ ok: true, migrationId: storage.migrationId }));
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector("#thumbnailStorageSummary")?.textContent)
      .toContain("Workers KV: 4 thumbnails"));

    document.querySelector<HTMLButtonElement>("#disableThumbnailStorage")?.click();
    await vi.waitFor(() => expect(document.querySelector("#thumbnailStorageSummary")?.textContent)
      .toContain("Disabled"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/storage/thumbnails/disable",
      expect.objectContaining({ method: "POST" }),
    );
    expect(document.querySelector<HTMLButtonElement>("#enableKvThumbnailStorage")?.hidden)
      .toBe(false);

    document.querySelector<HTMLButtonElement>("#enableKvThumbnailStorage")?.click();
    await vi.waitFor(() => expect(document.querySelector("#thumbnailStorageSummary")?.textContent)
      .toContain("Workers KV"));
    document.querySelector<HTMLButtonElement>("#migrateThumbnailStorage")?.click();
    await vi.waitFor(() => expect(document.querySelector("#thumbnailStorageMigration")?.textContent)
      .toContain("copying"));
    expect(document.querySelector<HTMLButtonElement>("#approveThumbnailCleanup")?.hidden)
      .toBe(true);
    window.dispatchEvent(new Event("pagehide"));
  });

  it("shows and independently revokes Cloudflare-paired Chrome devices", async () => {
    let connected = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: settingsState() }));
      if (path === "/api/mcp/connections") {
        return Promise.resolve(json({ endpoint: location.origin + "/mcp", connections: [] }));
      }
      if (path === "/api/storage/thumbnails") {
        return Promise.resolve(json({ storage: thumbnailStorageState() }));
      }
      if (path === "/api/catalogs") return Promise.resolve(json({ catalogs: catalogState() }));
      if (path === "/api/capture/devices") {
        return Promise.resolve(json({ devices: connected ? [{
          id: "device_12345678",
          name: "Chrome on Mac",
          connectedAt: "2026-08-21T00:00:00.000Z",
          lastUsedAt: null,
        }] : [] }));
      }
      if (path === "/api/capture/devices/device_12345678" && init?.method === "DELETE") {
        connected = false;
        return Promise.resolve(json({ ok: true }));
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Settings opens the shared how-to overlay at the panel it belongs to.
    document.querySelector<HTMLButtonElement>('[data-how-to="chrome"]')?.click();
    const dialog = document.querySelector<HTMLDialogElement>("#howToDialog");
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#howToTitle")?.textContent)
      .toBe("Save from Chrome");
    expect(document.querySelector('a[href="/extension/chrome"]')).toBeNull();
    expect(document.querySelector('[data-how-to="firefox"]')).toBeNull();
    document.querySelector<HTMLButtonElement>("#closeHowTo")?.click();
    expect(dialog?.open).toBe(false);
    await vi.waitFor(() => {
      expect(document.querySelector("#extensionDevices")?.textContent).toContain("Chrome on Mac");
    });
    expect(document.querySelector("#extensionCredential")).toBeNull();
    document.querySelector<HTMLButtonElement>("#extensionDevices button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("#extensionDevices")?.textContent)
        .toContain("No Chrome devices connected yet.");
    });
    window.dispatchEvent(new Event("pagehide"));
  });

  it("reveals iOS secrets and manages OAuth-connected AI assistants", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";
    const endpoint = location.origin + "/mcp";
    let connected = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: settingsState() }));
      if (path === "/api/capture/credentials") {
        return Promise.resolve(json({ credential: { token } }));
      }
      if (path === "/api/mcp/connections") {
        return Promise.resolve(json({
          endpoint,
          connections: connected ? [{
            id: "11111111-1111-4111-8111-111111111111",
            clientType: "chatgpt",
            displayName: "ChatGPT",
            scope: "library:read",
            connectedAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          }] : [],
        }));
      }
      if (path === "/api/storage/thumbnails") {
        return Promise.resolve(json({ storage: thumbnailStorageState() }));
      }
      if (path === "/api/catalogs") return Promise.resolve(json({ catalogs: catalogState() }));
      if (path === "/api/capture/devices") return Promise.resolve(json({ devices: [] }));
      if (path.endsWith("/api/mcp/connections/11111111-1111-4111-8111-111111111111") &&
          init?.method === "DELETE") {
        connected = false;
        return Promise.resolve(json({ ok: true }));
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

    await vi.waitFor(() => {
      expect(document.querySelector("#mcpConnections")?.textContent)
        .toContain("ChatGPT — Connected ✓");
    });
    expect(document.querySelector("#mcpConnections")?.textContent)
      .toContain("Read-only access · Last used just now");
    const quotedEndpoint = `'${endpoint}'`;
    document.querySelector<HTMLButtonElement>("#copyCodexMcpCommand")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `codex mcp add later-gator --url ${quotedEndpoint} && codex mcp login later-gator`,
    ));
    document.querySelector<HTMLButtonElement>("#copyClaudeMcpCommand")?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `claude mcp add --transport http --scope user later-gator ${quotedEndpoint} && claude mcp login later-gator`,
    ));
    document.querySelector<HTMLButtonElement>("#mcpConnections button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("#mcpConnections")?.textContent)
        .toContain("No AI assistants connected yet.");
    });
    document.querySelector<HTMLButtonElement>('[data-how-to="mcp"]')?.click();
    expect(dialog?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#howToTitle")?.textContent)
      .toBe("Connect Codex or Claude Code");
    const guide = document.querySelector<HTMLElement>("#howToBody")?.textContent ?? "";
    expect(guide).toContain("you never copy a secret token");
    expect(guide).toContain("you never copy a secret token or enable a developer mode");
    expect(guide).toContain("codex mcp list");
    expect(guide).toContain("claude mcp list");
    expect(guide).toContain("does not recognize claude mcp login");
    expect(guide).toContain("use /mcp to finish authentication");
    expect(guide).toContain("Use Later Gator to get my library status");
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
      if (path.startsWith("/api/mcp/connections")) {
        return Promise.resolve(json({ endpoint: location.origin + "/mcp", connections: [] }));
      }
      if (path.startsWith("/api/storage/thumbnails")) {
        return Promise.resolve(json({ storage: thumbnailStorageState() }));
      }
      if (path.startsWith("/api/catalogs")) {
        return Promise.resolve(json({ catalogs: catalogState() }));
      }
      if (path.startsWith("/api/capture/devices")) {
        return Promise.resolve(json({ devices: [] }));
      }
      if (path.startsWith("/api/providers/test")) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: false,
          error: { code: "provider_test_invalid", message: "That model did not return the structured JSON Later Gator needs." },
        }), { status: 422, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(json({ ok: true }));
    }));

    await import("../src/main");
    const model = document.getElementById("providerModel");
    const status = document.querySelector<HTMLElement>("#providerStatus");
    if (!(model instanceof HTMLSelectElement) || status === null) {
      throw new Error("provider form missing");
    }
    await vi.waitFor(() => expect(model.value).toBe("test-model"));

    model.value = "@cf/nvidia/nemotron-3-120b-a12b";
    model.dispatchEvent(new Event("change", { bubbles: true }));
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
    model.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.value).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    window.dispatchEvent(new Event("pagehide"));
    vi.useRealTimers();
  });

  it("keeps an unknown active model visible and disables another deprecated model", async () => {
    const bootstrap = settingsState();
    bootstrap.provider.model = "legacy-active-model";
    const catalogs = catalogState();
    const deprecatedModel = catalogs.models.models[0] as
      | { deprecatedAfter: string | null }
      | undefined;
    if (deprecatedModel === undefined) throw new Error("deprecated model fixture missing");
    deprecatedModel.deprecatedAfter = "2026-08-01T00:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path.startsWith("/api/bootstrap")) return Promise.resolve(json({ state: bootstrap }));
      if (path.startsWith("/api/mcp/connections")) {
        return Promise.resolve(json({ endpoint: location.origin + "/mcp", connections: [] }));
      }
      if (path.startsWith("/api/storage/thumbnails")) {
        return Promise.resolve(json({ storage: thumbnailStorageState() }));
      }
      if (path.startsWith("/api/catalogs")) return Promise.resolve(json({ catalogs }));
      if (path.startsWith("/api/capture/devices")) return Promise.resolve(json({ devices: [] }));
      return Promise.resolve(json({ ok: true }));
    }));

    await import("../src/main");

    const model = document.getElementById("providerModel");
    if (!(model instanceof HTMLSelectElement)) throw new Error("provider model select missing");
    await vi.waitFor(() => expect(model.value).toBe("legacy-active-model"));
    const options = [...model.options];
    expect(options[0]?.textContent).toBe(
      "legacy-active-model — current model unavailable in catalog",
    );
    const deprecated = options.find((option) => option.value === "test-model");
    expect(deprecated?.textContent).toBe("Test model — deprecated");
    expect(deprecated?.disabled).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
  });
});
