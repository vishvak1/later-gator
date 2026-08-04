import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardPage } from "../../src/v6/routes/pages";

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
        bookmark_count: 0,
      },
    ],
    tags: [{
      id: "tag_systems",
      normalized_name: "systems",
      display_name: "systems",
      status: "active",
      usage_count: 4,
    }],
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

describe("bookmark editor tags", () => {
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

  it("selects existing hash tags and creates new ones without explanatory labels", async () => {
    const bookmarkId = "00000000-0000-4000-8000-000000000321";
    let savedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = requestPath(input);
      if (path === "/api/bootstrap") return Promise.resolve(json({ state: bootstrap() }));
      if (path.startsWith("/api/bookmarks?")) {
        return Promise.resolve(json({
          bookmarks: [{
            id: bookmarkId,
            title: "Editable bookmark",
            description: null,
            folder_name: "Articles",
            hostname: "example.com",
            added_at: "2026-08-03T00:00:00.000Z",
            favorite: 0,
            tag_names: null,
            thumbnail_id: null,
            thumbnail_width: null,
            thumbnail_height: null,
          }],
          total: 1,
          nextCursor: null,
        }));
      }
      if (path === "/api/bookmarks/" + bookmarkId && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(json({ bookmark: {
          id: bookmarkId,
          revision: 3,
          url: "https://example.com/editor-tags",
          title: "Editable bookmark",
          description: null,
          note: null,
          folder_id: "folder_articles",
          folder_name: "Articles",
          favorite: 0,
          hostname: "example.com",
          added_at: "2026-08-03T00:00:00.000Z",
          source_created_at: "2026-08-03T00:00:00.000Z",
          modified_at: "2026-08-03T00:00:00.000Z",
          tags: [],
          relatedBookmarks: [],
          thumbnailAvailable: false,
        } }));
      }
      if (path === "/api/bookmarks/" + bookmarkId && init?.method === "PATCH") {
        const body = typeof init.body === "string" ? init.body : "{}";
        savedBody = JSON.parse(body) as Record<string, unknown>;
        return Promise.resolve(json({ ok: true }));
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".bookmark-card")).not.toBeNull());
    document.querySelector<HTMLElement>(".bookmark-card")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLDialogElement>("#bookmarkDialog")?.open).toBe(true);
    });
    document.querySelector<HTMLButtonElement>("#editDetailButton")?.click();

    const tagInput = document.querySelector<HTMLInputElement>("#bookmarkTagInput");
    if (tagInput === null) throw new Error("Bookmark tag input was not rendered");
    tagInput.value = "#syst";
    tagInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("#bookmarkTagSuggestions")?.textContent).toContain("#systems");
    expect(document.querySelector("#bookmarkTagSuggestions")?.textContent).not.toContain("Existing tag");
    document.querySelector<HTMLButtonElement>("#bookmarkTagSuggestions [data-tag-name]")?.click();

    tagInput.value = "#new tag";
    tagInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("#bookmarkTagSuggestions")?.textContent).toContain("Create #new-tag");
    expect(document.querySelector("#bookmarkTagSuggestions")?.textContent).not.toContain("New tag");
    document.querySelector<HTMLButtonElement>("#bookmarkTagSuggestions [data-create-tag]")?.click();
    expect(document.querySelector("#bookmarkSelectedTags")?.textContent).toContain("#systems");
    expect(document.querySelector("#bookmarkSelectedTags")?.textContent).toContain("#new-tag");

    document.querySelector<HTMLFormElement>("#bookmarkForm")?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(savedBody).not.toBeNull());
    expect(savedBody).toMatchObject({ expectedRevision: 3, tags: ["systems", "new-tag"] });
  });
});
