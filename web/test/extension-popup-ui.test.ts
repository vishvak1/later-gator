import { beforeEach, describe, expect, it, vi } from "vitest";
import popupHtml from "../../extension/shared/popup.html?raw";
import { extensionConnectionCode } from "../src/extension-connection";

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
  return {
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
  await import("../../extension/shared/common.js");
  // @ts-expect-error The shipped WebExtension script is intentionally plain JavaScript.
  await import("../../extension/shared/popup.js");
}

function visiblePanels(): string[] {
  return ["loadingPanel", "connectionPanel", "captureForm", "successPanel"].filter(
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

  it("validates a new connection code before storing it", async () => {
    const browser = browserMock(null);
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      json({ error: { message: "Reconnect Later Gator." } }, 401),
    ));

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["connectionPanel"]));
    const codeInput = document.querySelector<HTMLTextAreaElement>("#connectionCode");
    if (codeInput === null) throw new Error("Connection code field is missing");
    codeInput.value = extensionConnectionCode(deployment, token);
    document.querySelector<HTMLFormElement>("#connectionPanel")?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(document.querySelector("#connectionStatus")?.textContent).toBe("Reconnect Later Gator.");
    });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(visiblePanels()).toEqual(["connectionPanel"]);
  });

  it("accepts the one-part Settings code and stores its deployment and token", async () => {
    const browser = browserMock(null);
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(optionsResponse()));

    await renderPopup();
    await vi.waitFor(() => expect(visiblePanels()).toEqual(["connectionPanel"]));
    const codeInput = document.querySelector<HTMLTextAreaElement>("#connectionCode");
    if (codeInput === null) throw new Error("Connection code field is missing");
    codeInput.value = extensionConnectionCode(deployment, token);
    document.querySelector<HTMLFormElement>("#connectionPanel")?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(visiblePanels()).toEqual(["captureForm"]));
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      laterGatorConnection: { deployment, token },
    });
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
});
