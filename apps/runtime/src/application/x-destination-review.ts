import { z } from "zod";
import { normalizeBookmarkUrl } from "../domain/url";
import { createBookmark, relateBookmarks } from "../adapters/library-repository";
import { dispatchJob, dispatchThumbnailJob } from "./queue-dispatch";

export const xDestinationDecisionSchema = z.strictObject({
  selectedReviewIds: z.array(z.uuid()).max(4),
});

interface ExistingDestination {
  id: string;
}

interface ReviewRow {
  id: string;
  destination_url: string;
  existing_bookmark_id: string | null;
}

/** Stores an iOS X-post decision only when at least one destination already exists. */
export async function stageXDestinationReview(
  db: D1Database,
  jobId: string,
  postBookmarkId: string,
  urls: string[],
): Promise<boolean> {
  const rows: {
    id: string;
    url: string;
    normalizedUrl: string;
    existingId: string | null;
  }[] = [];
  for (const rawUrl of [...new Set(urls)].slice(0, 4)) {
    const normalized = normalizeBookmarkUrl(rawUrl);
    const existing = await db
      .prepare(
        `SELECT id FROM bookmarks
          WHERE normalized_url = ? AND deleted_at IS NULL AND id != ?
          LIMIT 1`,
      )
      .bind(normalized.normalizedUrl, postBookmarkId)
      .first<ExistingDestination>();
    rows.push({
      id: crypto.randomUUID(),
      url: normalized.url,
      normalizedUrl: normalized.normalizedUrl,
      existingId: existing?.id ?? null,
    });
  }
  if (!rows.some(row => row.existingId !== null)) return false;

  const now = new Date().toISOString();
  const statements = rows.map(row =>
    db
      .prepare(
        `INSERT OR IGNORE INTO x_destination_reviews (
          id, post_bookmark_id, destination_url, normalized_url,
          existing_bookmark_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, postBookmarkId, row.url, row.normalizedUrl, row.existingId, now),
  );
  statements.push(
    db
      .prepare(
        `UPDATE bookmarks
            SET folder_id = 'folder_need_review', ai_state = 'review',
                modified_at = ?, revision = revision + 1
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(now, postBookmarkId),
    db
      .prepare(
        `UPDATE background_jobs
            SET state = 'review', last_safe_error_code = 'x_destination_already_saved',
                completed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(now, now, jobId),
  );
  await db.batch(statements);
  return true;
}

/** Returns the safe owner-facing destination review and local related X posts. */
export async function getXDestinationReview(
  db: D1Database,
  postBookmarkId: string,
): Promise<object | null> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.destination_url, r.existing_bookmark_id,
              b.title AS existing_title, b.hostname AS existing_hostname
         FROM x_destination_reviews r
         LEFT JOIN bookmarks b ON b.id = r.existing_bookmark_id AND b.deleted_at IS NULL
        WHERE r.post_bookmark_id = ?
        ORDER BY r.created_at, r.id`,
    )
    .bind(postBookmarkId)
    .all<ReviewRow & { existing_title: string | null; existing_hostname: string | null }>();
  if (rows.results.length === 0) return null;

  const items = [];
  for (const row of rows.results) {
    const posts = row.existing_bookmark_id === null
      ? { results: [] as Record<string, unknown>[] }
      : await db
          .prepare(
            `SELECT p.id, p.title, p.url, p.hostname
               FROM bookmark_relationships rel
               JOIN bookmarks p ON p.id = CASE
                 WHEN rel.left_bookmark_id = ? THEN rel.right_bookmark_id
                 ELSE rel.left_bookmark_id
               END
              WHERE (rel.left_bookmark_id = ? OR rel.right_bookmark_id = ?)
                AND p.deleted_at IS NULL
                AND p.id != ?
                AND p.hostname IN ('x.com', 'twitter.com', 'mobile.twitter.com')
              ORDER BY p.modified_at DESC`,
          )
          .bind(
            row.existing_bookmark_id,
            row.existing_bookmark_id,
            row.existing_bookmark_id,
            postBookmarkId,
          )
          .all();
    items.push({
      id: row.id,
      destinationUrl: row.destination_url,
      existingBookmarkId: row.existing_bookmark_id,
      existingTitle: row.existing_title,
      existingHostname: row.existing_hostname,
      linkedPosts: posts.results,
    });
  }
  return { postBookmarkId, items };
}

/** Keeps the reviewed X post, connects selected destinations, and clears the review. */
export async function keepXDestinationReview(
  env: Env,
  postBookmarkId: string,
  selectedReviewIds: string[],
): Promise<boolean> {
  const rows = await env.DB
    .prepare(
      `SELECT id, destination_url, existing_bookmark_id
         FROM x_destination_reviews
        WHERE post_bookmark_id = ?
        ORDER BY created_at, id`,
    )
    .bind(postBookmarkId)
    .all<ReviewRow>();
  if (rows.results.length === 0) return false;
  const selected = new Set(selectedReviewIds);
  const selectedUrls = rows.results
    .filter(row => selected.has(row.id))
    .map(row => row.destination_url);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET folder_id = 'folder_social_posts', ai_state = 'complete',
                organization_policy = 'none', modified_at = ?, revision = revision + 1
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(now, postBookmarkId),
    env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = 'completed', last_safe_error_code = NULL, updated_at = ?
          WHERE bookmark_id = ? AND state = 'review'
            AND last_safe_error_code = 'x_destination_already_saved'`,
      )
      .bind(now, postBookmarkId),
    env.DB.prepare("DELETE FROM x_destination_reviews WHERE post_bookmark_id = ?").bind(postBookmarkId),
  ]);
  for (const url of selectedUrls) {
    const destination = await createBookmark(
      env.DB,
      { url, folderId: "folder_unsorted", organizationPolicy: "full" },
      "linked",
    );
    if (destination.bookmark.id === postBookmarkId) continue;
    await relateBookmarks(env.DB, postBookmarkId, destination.bookmark.id);
    if (destination.jobId !== null) {
      await dispatchJob(env.DB, env.BACKGROUND_QUEUE, destination.jobId);
    }
    if (destination.thumbnailJobId !== null) {
      await dispatchThumbnailJob(env.DB, env.THUMBNAIL_QUEUE, destination.thumbnailJobId);
    }
  }
  return true;
}
