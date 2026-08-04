import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardPage } from "../../src/v6/routes/pages";

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

function bookmark(index: number) {
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    title: `Bookmark ${index.toString()}`,
    description: null,
    folder_name: "Articles",
    hostname: "filtered.example",
    added_at: "2026-08-03T00:00:00.000Z",
    favorite: 0,
    tag_names: null,
    thumbnail_id: null,
    thumbnail_width: null,
    thumbnail_height: null,
  };
}

const bookmarks = Array.from({ length: 101 }, (_, index) => bookmark(index + 1));

function bootstrap() {
  return {
    setupStatus: "complete",
    ownerAiPaused: false,
    personalInstructions: null,
    activeImport: null,
    folders: [
      {
        id: "folder_unsorted",
        slug: "unsorted",
        name: "Unsorted",
        kind: "system",
        sort_order: 1,
        is_ai_destination: 0,
        bookmark_count: 0,
      },
      {
        id: "folder_articles",
        slug: "articles",
        name: "Articles",
        kind: "content",
        sort_order: 2,
        is_ai_destination: 1,
        bookmark_count: 101,
      },
    ],
    tags: [],
    sites: ["filtered.example"],
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

describe("dashboard bookmark selection", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    const html = await dashboardPage().text();
    const body = /<body[^>]*>([\s\S]*?)<script type="module"/u.exec(html)?.[1];
    if (body === undefined) throw new Error("Dashboard page body was not rendered");
    document.body.dataset.page = "dashboard";
    document.body.innerHTML = body;
  });

  it("selects every cursor page matching the active folder and filters", async () => {
    const selectAllQueries: URLSearchParams[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: bootstrap() }));
      if (!path.startsWith("/api/bookmarks?")) {
        throw new Error("Unexpected request: " + path);
      }
      const query = new URL(path, "https://later-gator.test").searchParams;
      if (query.get("limit") === "100") {
        selectAllQueries.push(new URLSearchParams(query));
        if (query.get("cursor") === "selection-page-2") {
          return Promise.resolve(json({ bookmarks: bookmarks.slice(100), total: 101, nextCursor: null }));
        }
        return Promise.resolve(json({
          bookmarks: bookmarks.slice(0, 100),
          total: 101,
          nextCursor: "selection-page-2",
        }));
      }
      return Promise.resolve(json({ bookmarks: bookmarks.slice(0, 1), total: 101, nextCursor: "ui-page-2" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelectorAll(".bookmark-card")).toHaveLength(1));

    const siteFilter = document.querySelector<HTMLInputElement>("#siteInput");
    if (siteFilter === null) throw new Error("Site filter was not rendered");
    siteFilter.value = "filtered.example";
    document.querySelector<HTMLButtonElement>('[data-folder="folder_articles"]')?.click();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => {
        const path = requestPath(input);
        return path.includes("folder=folder_articles") && path.includes("hostname=filtered.example");
      })).toBe(true);
    });

    document.querySelector<HTMLInputElement>("[data-select-id]")?.click();
    document.querySelector<HTMLButtonElement>("#bulkSelectAll")?.click();

    await vi.waitFor(() => {
      expect(document.querySelector("#bulkCount")?.textContent).toBe("101 selected");
    });
    expect(selectAllQueries).toHaveLength(2);
    expect(selectAllQueries.every(query => query.get("folder") === "folder_articles")).toBe(true);
    expect(selectAllQueries.every(query => query.get("hostname") === "filtered.example")).toBe(true);
    expect(document.querySelector<HTMLInputElement>("[data-select-id]")?.checked).toBe(true);
  });
});
