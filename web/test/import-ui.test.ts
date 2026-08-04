import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardPage } from "../../src/v6/routes/pages";

const importId = "00000000-0000-4000-8000-000000000268";

function importState(
  status: "committing" | "committed",
  committedRows: number,
) {
  return {
    id: importId,
    status,
    option: "reorganize",
    file_name: "export.csv",
    total_rows: 268,
    valid_rows: 265,
    invalid_rows: 0,
    duplicate_rows: 3,
    committed_rows: committedRows,
    failed_rows: 0,
    processed_rows: committedRows + 3,
  };
}

function bootstrap() {
  return {
    setupStatus: "complete",
    ownerAiPaused: false,
    personalInstructions: null,
    activeImport: importState("committing", 0),
    folders: [{
      id: "folder_unsorted",
      slug: "unsorted",
      name: "Unsorted",
      kind: "system",
      sort_order: 1,
      is_ai_destination: 0,
      bookmark_count: 0,
    }],
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("dashboard import progress", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    const html = await dashboardPage().text();
    const body = /<body[^>]*>([\s\S]*?)<script type="module"/u.exec(html)?.[1];
    if (body === undefined) throw new Error("Dashboard page body was not rendered");
    document.body.dataset.page = "dashboard";
    document.body.innerHTML = body;
  });

  it("shows real row progress while keeping dashboard navigation available", async () => {
    let resolveCompletion: ((response: Response) => void) | undefined;
    const completion = new Promise<Response>(resolve => { resolveCompletion = resolve; });
    let statusReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: bootstrap() }));
      if (path.startsWith("/api/bookmarks?")) {
        return Promise.resolve(json({ bookmarks: [], total: 0, nextCursor: null }));
      }
      if (path === "/api/imports/" + importId) {
        statusReads += 1;
        if (statusReads === 1) {
          return Promise.resolve(json({ import: importState("committing", 97) }));
        }
        return completion;
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(statusReads).toBeGreaterThanOrEqual(2), { timeout: 2500 });

    expect(document.querySelector<HTMLElement>("#importProgressPanel")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#importProgressPanel")?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector<HTMLElement>("#importSpinner")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#importProgressWrap")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#importProgressBar")?.style.width).toBe("37%");
    expect(document.querySelector("#importProgressLabel")?.textContent).toContain("100 of 268 rows processed");
    expect(document.querySelector("#importProgressLabel")?.textContent).toContain("97 added");
    expect(document.querySelector<HTMLAnchorElement>('a[href="/settings"]')).not.toBeNull();

    resolveCompletion?.(json({ import: importState("committed", 265) }));
    await vi.waitFor(
      () => expect(document.querySelector<HTMLElement>("#importProgressPanel")?.hidden).toBe(true),
      { timeout: 4000 },
    );
  });

  it("renders the thumbnail UUID in the private image URL", async () => {
    const bookmarkId = "00000000-0000-4000-8000-000000000111";
    const thumbnailId = "00000000-0000-4000-8000-000000000222";
    const state = { ...bootstrap(), activeImport: null };
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state }));
      if (path.startsWith("/api/bookmarks?")) {
        return Promise.resolve(json({
          bookmarks: [{
            id: bookmarkId,
            title: "Versioned thumbnail",
            description: null,
            folder_name: "Articles",
            hostname: "example.com",
            added_at: "2026-08-02T00:00:00.000Z",
            favorite: 0,
            tag_names: null,
            thumbnail_id: thumbnailId,
            thumbnail_width: 640,
            thumbnail_height: 480,
          }],
          total: 1,
          nextCursor: null,
        }));
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLImageElement>(".bookmark-card img")?.getAttribute("src"))
        .toBe(`/api/thumbnails/${bookmarkId}/${thumbnailId}`);
    });
  });

  it("silently retries transient status failures instead of showing an unavailable error", async () => {
    let resolveRecovery: ((response: Response) => void) | undefined;
    const recovery = new Promise<Response>(resolve => { resolveRecovery = resolve; });
    let statusReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: bootstrap() }));
      if (path.startsWith("/api/bookmarks?")) {
        return Promise.resolve(json({ bookmarks: [], total: 0, nextCursor: null }));
      }
      if (path === "/api/imports/" + importId) {
        statusReads += 1;
        if (statusReads <= 3) return Promise.reject(new TypeError("NetworkError"));
        if (statusReads === 4) return recovery;
        return Promise.resolve(json({ import: importState("committed", 265) }));
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(statusReads).toBe(4), { timeout: 3000 });
    expect(document.querySelector("#importPanelTitle")?.textContent).toBe("Importing bookmarks");
    expect(document.querySelector("#importPanelMessage")?.textContent).toContain("checking again automatically");
    expect(document.body.textContent).not.toContain("Import status unavailable");
    expect(document.body.textContent).not.toContain("Retry safely");

    resolveRecovery?.(json({ import: importState("committing", 197) }));
    await vi.waitFor(
      () => expect(document.querySelector<HTMLElement>("#importProgressPanel")?.hidden).toBe(true),
      { timeout: 4500 },
    );
    expect(document.querySelector("#libraryStatus")?.classList.contains("error")).toBe(false);
  });
});
