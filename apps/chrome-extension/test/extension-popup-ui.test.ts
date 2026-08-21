import { beforeEach, describe, expect, it, vi } from "vitest";
import popupHtml from "../src/popup.html?raw";

const deployment = "https://later-gator.example.workers.dev";
const token = "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function optionsResponse(): Response {
  return json({
    ok: true,
    folders: [
      { id: "folder_unsorted", name: "Unsorted", slug: "unsorted" },
      { id: "folder_articles", name: "Articles", slug: "articles" },
    ],
    tags: [
      { id: "tag_systems", display_name: "systems", normalized_name: "systems", usage_count: 3 },
    ],
  });
}

function browserMock(storedConnection: { deployment: string; token: string } | null) {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  return {
    identity: {
      getRedirectURL: vi.fn(() => `https://${extensionId}.chromiumapp.org/cloudflare`),
      launchWebAuthFlow: vi.fn(({ url }: { url: string }) => {
        const request = new URL(url);
        const callback = new URL(`https://${extensionId}.chromiumapp.org/cloudflare`);
        callback.searchParams.set("grant", "g".repeat(96));
        callback.searchParams.set("deployment", deployment);
        callback.searchParams.set("device_id", request.searchParams.get("device_id") ?? "");
        callback.searchParams.set("device_name", request.searchParams.get("device_name") ?? "");
        callback.searchParams.set("state", request.searchParams.get("state") ?? "");
        return Promise.resolve(callback.toString());
      }),
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn().mockResolvedValue(true),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue(
          storedConnection === null ? {} : { laterGatorConnection: storedConnection },
        ),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{
        id: 7,
        url: "https://example.com/article",
        title: "Example article",
      }]),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{
        result: { description: "Example description", image: "" },
      }]),
    },
    action: {
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function renderPopup(): Promise<void> {
  const body = /<body>([\s\S]*?)<\/body>/u.exec(popupHtml)?.[1];
  if (body === undefined) throw new Error("Extension popup body was not rendered");
  document.body.innerHTML = body.replaceAll(/\s*<script[^>]*><\/script>/gu, "");
  // @ts-expect-error The shipped WebExtension script is intentionally plain JavaScript.
  await import("../src/config.js");
  // @ts-expect-error The shipped WebExtension script is intentionally plain JavaScript.
  await import("../src/common.js");
  // @ts-expect-error The shipped WebExtension script is intentionally plain JavaScript.
  await import("../src/popup.js");
}

function visiblePanels(): string[] {
  return ["loadingPanel", "connectionPanel", "captureForm", "duplicatePanel", "successPanel"].filter(
    id => document.getElementById(id)?.hidden === false,
  );
}

describe("extension popup connection lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows only bookmark capture after validating a stored connection", async () => {
    const browser = browserMock({ deployment, token });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(optionsResponse()));

    await renderPopup();

    await vi.waitFor(() => expect(visiblePanels()).toEqual(["captureForm"]));
    expect(document.querySelector("#reconnectButton")).toBeNull();
    expect(document.querySelector<HTMLElement>("#connectionSettings")?.hidden).toBe(false);
    expect(document.querySelector("#sourceUrl")).toBeNull();
    expect(document.querySelector<HTMLFieldSetElement>("#tagFieldset")?.disabled).toBe(true);
    expect(document.querySelector<HTMLFieldSetElement>("#linkedFieldset")?.disabled).toBe(true);
  });

  it("removes a rejected credential and shows only the connection screen", async () => {
    const browser = browserMock({ deployment, token });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      json({ error: { message: "Reconnect Later Gator." } }, 401),
    ));

    await renderPopup();

    await vi.waitFor(() => expect(visiblePanels()).toEqual(["connectionPanel"]));
    expect(browser.storage.local.remove).toHaveBeenCalledWith("laterGatorConnection");
    expect(document.querySelector("#connectionStatus")?.textContent).toContain("no longer valid");
  });

  it("retains the connection and offers retry during a temporary outage", async () => {
    const browser = browserMock({ deployment, token });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      json({ error: { message: "Unavailable" } }, 503),
    ));

    await renderPopup();

    await vi.waitFor(() => expect(visiblePanels()).toEqual(["loadingPanel"]));
    expect(document.querySelector<HTMLElement>("#retryButton")?.hidden).toBe(false);
    expect(browser.storage.local.remove).not.toHaveBeenCalled();
  });

  it("stores nothing when Cloudflare sign-in is cancelled", async () => {
    const browser = browserMock(null);
    browser.identity.launchWebAuthFlow.mockRejectedValueOnce(new Error("cancelled"));
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn());

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["connectionPanel"]));
    document.querySelector<HTMLButtonElement>("#connectButton")?.click();

    await vi.waitFor(() => {
      expect(document.querySelector("#connectionStatus")?.textContent).toContain("cancelled");
    });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(visiblePanels()).toEqual(["connectionPanel"]);
  });

  it("uses Cloudflare identity, exact-origin permission, and one-time runtime exchange", async () => {
    const browser = browserMock(null);
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/capture/pair")) {
        return json({ ok: true, credential: { token } }, 201);
      }
      return optionsResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["connectionPanel"]));
    document.querySelector<HTMLButtonElement>("#connectButton")?.click();

    await vi.waitFor(() => expect(visiblePanels()).toEqual(["captureForm"]));
    expect(browser.identity.launchWebAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      interactive: true,
    }));
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: [deployment + "/*"] });
    expect(fetchMock.mock.calls.some(([input]) => {
      const address = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      return address.endsWith("/api/capture/pair");
    })).toBe(true);
    const saved = browser.storage.local.set.mock.calls.at(-1)?.[0] as unknown;
    expect(saved).toMatchObject({ laterGatorConnection: { deployment, token } });
  });

  it("stores nothing and never exchanges the grant when exact-origin permission is declined", async () => {
    const browser = browserMock(null);
    browser.permissions.request.mockResolvedValueOnce(false);
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["connectionPanel"]));
    document.querySelector<HTMLButtonElement>("#connectButton")?.click();

    await vi.waitFor(() => {
      expect(document.querySelector("#connectionStatus")?.textContent)
        .toContain("Access to your personal Later Gator was not granted");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(visiblePanels()).toEqual(["connectionPanel"]);
  });

  it("shows an already-saved page and adds a tick to the regular toolbar icon", async () => {
    const browser = browserMock({ deployment, token });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/capture/options")) return optionsResponse();
      if (url.endsWith("/api/capture/bookmark-status")) return json({ ok: true, saved: true });
      return json({ error: { message: "Unexpected request" } }, 500);
    });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", fetchMock);

    await renderPopup();

    await vi.waitFor(() => expect(visiblePanels()).toEqual(["successPanel"]));
    expect(document.querySelector("#successTitle")?.textContent).toBe("Already saved!");
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "✓", tabId: 7 });
    expect(browser.action.setTitle).toHaveBeenCalledWith({
      title: "Saved in Later Gator",
      tabId: 7,
    });
  });

  it("adds hash-prefixed tags and links an existing bookmark in a permanent folder", async () => {
    const browser = browserMock({ deployment, token });
    let captureBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const requestBody = typeof init?.body === "string" ? init.body : "";
      if (url.endsWith("/api/capture/options")) return optionsResponse();
      if (url.endsWith("/api/capture/bookmark-search")) {
        expect(JSON.parse(requestBody)).toEqual({ query: "Target" });
        return json({
          ok: true,
          bookmarks: [{
            id: "bookmark_target",
            title: "Target bookmark",
            url: "https://target.example/read",
            hostname: "target.example",
            folder_name: "Articles",
          }],
        });
      }
      if (url.endsWith("/api/capture/bookmarks")) {
        captureBody = JSON.parse(requestBody) as Record<string, unknown>;
        return json({ ok: true, result: "saved_and_linked" }, 201);
      }
      return json({ error: { message: "Unexpected request" } }, 500);
    });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", fetchMock);

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["captureForm"]));

    const folder = document.getElementById("folder") as HTMLSelectElement | null;
    const tagInput = document.querySelector<HTMLInputElement>("#tagInput");
    const linkedSearch = document.querySelector<HTMLInputElement>("#linkedSearch");
    if (folder === null || tagInput === null || linkedSearch === null) {
      throw new Error("Extension organization fields are missing");
    }
    folder.value = "folder_articles";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector<HTMLFieldSetElement>("#tagFieldset")?.disabled).toBe(false);
    expect(document.querySelector<HTMLFieldSetElement>("#linkedFieldset")?.disabled).toBe(false);

    tagInput.value = "#syst";
    tagInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("#tagSuggestions")?.textContent).toContain("#systems");
    expect(document.querySelector("#tagSuggestions")?.textContent).not.toContain("Existing tag");

    tagInput.value = "#new topic";
    tagInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("#tagSuggestions")?.textContent).not.toContain("New tag");
    const createTag = [...document.querySelectorAll<HTMLButtonElement>("#tagSuggestions button")]
      .find(button => button.textContent?.includes("Create #new-topic"));
    createTag?.click();
    expect(document.querySelector("#selectedTags")?.textContent).toContain("#new-topic");

    linkedSearch.value = "Target";
    linkedSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector("#linkedSuggestions")?.textContent).toContain("Target bookmark");
    });
    document.querySelector<HTMLButtonElement>("#linkedSuggestions button")?.click();
    expect(document.querySelector("#selectedLinkedLabel")?.textContent).toBe("Target bookmark");

    document.querySelector<HTMLFormElement>("#captureForm")?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(captureBody).not.toBeNull());
    expect(captureBody).toMatchObject({
      url: "https://example.com/article",
      folderId: "folder_articles",
      tags: ["new-topic"],
      linkedUrl: "https://target.example/read",
    });
    /*
     * The thread-link read runs inside submit, and this mock answers every
     * injection with the page-metadata object rather than a list of links.
     * Saving has to survive that: spreading whatever came back straight into
     * the request body once threw here and lost the bookmark entirely.
     */
    const sent = captureBody as unknown as { postLinks?: unknown };
    expect(Array.isArray(sent.postLinks)).toBe(true);
    expect(sent.postLinks).toEqual([]);
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["successPanel"]));
    expect(document.querySelector("#successTitle")?.textContent).toBe("Saved and linked!");
    expect(document.querySelector<HTMLAnchorElement>("#openLaterGator")?.href)
      .toBe(deployment + "/dashboard");
    expect(document.querySelector<HTMLElement>("#popupHeader")?.hidden).toBe(true);
  });

  it("clears and disables manual organization when the folder returns to Unsorted", async () => {
    const browser = browserMock({ deployment, token });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(optionsResponse()));

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["captureForm"]));
    const folder = document.getElementById("folder") as HTMLSelectElement | null;
    const tagInput = document.querySelector<HTMLInputElement>("#tagInput");
    if (folder === null || tagInput === null) throw new Error("Folder controls are missing");
    folder.value = "folder_articles";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
    tagInput.value = "#systems";
    tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.querySelector("#selectedTags")?.textContent).toContain("#systems");

    folder.value = "folder_unsorted";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector<HTMLFieldSetElement>("#tagFieldset")?.disabled).toBe(true);
    expect(document.querySelector<HTMLFieldSetElement>("#linkedFieldset")?.disabled).toBe(true);
    expect(document.querySelector("#selectedTags")?.textContent).toBe("");
  });

  it("sends only individually selected X links and confirms duplicates before saving", async () => {
    const browser = browserMock({ deployment, token });
    browser.scripting.executeScript
      .mockResolvedValueOnce([{ result: {
        url: "https://x.com/owner/status/123",
        title: "X post",
        description: "Post body",
        image: "",
      } }])
      .mockResolvedValueOnce([{ result: [
        { url: "https://t.co/first", label: "first.example" },
        { url: "https://t.co/second", label: "second.example" },
      ] }]);
    const captures: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/capture/options")) return optionsResponse();
      if (url.endsWith("/api/capture/bookmark-status")) return json({ ok: true, saved: false });
      if (url.endsWith("/api/capture/bookmarks")) {
        const requestBody = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(requestBody) as Record<string, unknown>;
        captures.push(body);
        if (body.acceptExistingPostLinks !== true) {
          return json({
            ok: false,
            error: { code: "x_destination_already_saved", message: "Already saved" },
            duplicates: [{ title: "Existing first", url: "https://first.example", hostname: "first.example" }],
          }, 409);
        }
        return json({ ok: true, result: "saved" }, 201);
      }
      return json({ error: { message: "Unexpected request" } }, 500);
    });
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", fetchMock);

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["captureForm"]));
    const choices = [...document.querySelectorAll<HTMLInputElement>("[data-post-link]")];
    expect(choices).toHaveLength(2);
    const secondChoice = choices[1];
    if (secondChoice === undefined) throw new Error("Second X link checkbox is missing");
    secondChoice.checked = false;
    document.querySelector<HTMLFormElement>("#captureForm")?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["duplicatePanel"]));
    expect(captures[0]?.postLinks).toEqual(["https://t.co/first"]);

    document.querySelector<HTMLButtonElement>("#backFromDuplicate")?.click();
    expect(visiblePanels()).toEqual(["captureForm"]);
    document.querySelector<HTMLFormElement>("#captureForm")?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["duplicatePanel"]));
    document.querySelector<HTMLButtonElement>("#confirmDuplicate")?.click();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["successPanel"]));
    expect(captures.at(-1)).toMatchObject({
      postLinks: ["https://t.co/first"],
      acceptExistingPostLinks: true,
    });
  });
});
