import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBookmark } from "../src/adapters/library-repository";
import {
  getXDestinationReview,
  keepXDestinationReview,
  stageXDestinationReview,
} from "../src/application/x-destination-review";

describe("Share Sheet X destination review", () => {
  it("holds an existing destination for review and keeps only after owner confirmation", async () => {
    const suffix = crypto.randomUUID();
    const post = await createBookmark(
      env.DB,
      {
        url: `https://x.com/owner/status/${Date.now().toString()}`,
        folderId: "folder_social_posts",
        organizationPolicy: "none",
      },
      "ios",
    );
    const destination = await createBookmark(
      env.DB,
      {
        url: `https://destination.example/${suffix}`,
        title: "Existing destination",
        folderId: "folder_articles",
        organizationPolicy: "none",
      },
      "dashboard",
    );

    expect(await stageXDestinationReview(
      env.DB,
      crypto.randomUUID(),
      post.bookmark.id,
      [destination.bookmark.url],
    )).toBe(true);

    const held = await env.DB
      .prepare("SELECT folder_id, ai_state FROM bookmarks WHERE id = ?")
      .bind(post.bookmark.id)
      .first<{ folder_id: string; ai_state: string }>();
    expect(held).toEqual({ folder_id: "folder_need_review", ai_state: "review" });
    const review = await getXDestinationReview(env.DB, post.bookmark.id) as {
      items: { id: string; existingBookmarkId: string | null }[];
    } | null;
    expect(review?.items).toHaveLength(1);
    expect(review?.items[0]?.existingBookmarkId).toBe(destination.bookmark.id);

    expect(await keepXDestinationReview(
      env,
      post.bookmark.id,
      [review?.items[0]?.id ?? ""],
    )).toBe(true);
    const kept = await env.DB
      .prepare("SELECT folder_id, ai_state, organization_policy FROM bookmarks WHERE id = ?")
      .bind(post.bookmark.id)
      .first<{ folder_id: string; ai_state: string; organization_policy: string }>();
    expect(kept).toEqual({
      folder_id: "folder_social_posts",
      ai_state: "complete",
      organization_policy: "none",
    });
    const relation = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count FROM bookmark_relationships
          WHERE (left_bookmark_id = ? AND right_bookmark_id = ?)
             OR (left_bookmark_id = ? AND right_bookmark_id = ?)`,
      )
      .bind(
        post.bookmark.id,
        destination.bookmark.id,
        destination.bookmark.id,
        post.bookmark.id,
      )
      .first<{ count: number }>();
    expect(relation?.count).toBe(1);
    expect(await getXDestinationReview(env.DB, post.bookmark.id)).toBeNull();
  });
});
