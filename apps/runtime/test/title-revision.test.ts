import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBookmark } from "../src/adapters/library-repository";

describe("title backfill and organization revision", () => {
  it("resolving a placeholder title leaves the revision an organize job holds intact", async () => {
    const created = await createBookmark(
      env.DB,
      { url: "https://example.com/no-title-supplied", folderId: "folder_unsorted", organizationPolicy: "full" },
      "ios",
    );
    const id = created.bookmark.id;
    const before = created.bookmark.revision;
    // A share-sheet capture is titled with its hostname until something resolves it.
    expect(created.bookmark.title).toBe("example.com");

    // Exactly the write the thumbnail job performs once it has the page.
    await env.DB
      .prepare(
        `UPDATE bookmarks SET title = ?, modified_at = ?
          WHERE id = ? AND deleted_at IS NULL AND title = hostname`,
      )
      .bind("A real page title", new Date().toISOString(), id)
      .run();

    const after = await env.DB
      .prepare("SELECT title, revision FROM bookmarks WHERE id = ?")
      .bind(id)
      .first<{ title: string; revision: number }>();

    expect(after?.title).toBe("A real page title");
    /*
     * The organize job captured `before` when it started and writes its result
     * back only if the number still matches. Bumping it here made every result
     * land on zero rows, recorded as stale_ai_result_recovered and requeued for
     * five minutes, with the bookmark stranded in Unsorted and no notification
     * sent because a retry is not a change worth announcing.
     */
    expect(after?.revision).toBe(before);
  });
});
