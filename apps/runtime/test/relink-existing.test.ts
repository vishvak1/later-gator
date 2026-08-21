import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBookmark, relateBookmarks } from "../src/adapters/library-repository";

describe("linking a post that is already saved", () => {
  it("relates a destination to a bookmark that already existed, and does so once", async () => {
    const url = `https://x.com/someone/status/${Date.now().toString()}`;
    const first = await createBookmark(
      env.DB, { url, folderId: "folder_unsorted", organizationPolicy: "full" }, "extension",
    );
    expect(first.created).toBe(true);

    // Saving the same post again is how an owner picks up a link the author
    // added after the first save. The capture route used to skip link handling
    // entirely unless the bookmark was new, so that second save did nothing.
    const second = await createBookmark(
      env.DB, { url, folderId: "folder_unsorted", organizationPolicy: "full" }, "extension",
    );
    expect(second.created).toBe(false);
    expect(second.bookmark.id).toBe(first.bookmark.id);

    const destination = await createBookmark(
      env.DB,
      { url: `https://github.com/example/${Date.now().toString()}`, folderId: "folder_unsorted", organizationPolicy: "full" },
      "linked",
    );
    expect(await relateBookmarks(env.DB, second.bookmark.id, destination.bookmark.id)).toBe(true);
    // Idempotent, which is what makes running this on every save safe.
    expect(await relateBookmarks(env.DB, second.bookmark.id, destination.bookmark.id)).toBe(false);

    const rows = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM bookmark_relationships
          WHERE left_bookmark_id IN (?, ?) AND right_bookmark_id IN (?, ?)`,
      )
      .bind(first.bookmark.id, destination.bookmark.id, first.bookmark.id, destination.bookmark.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});
