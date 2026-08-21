import {
  ingestThumbnailCandidate,
  isPlaceholderThumbnail,
  scanPageForThumbnail,
  type ThumbnailCandidate,
} from "./thumbnails";
import { readThumbnailStorageState } from "../adapters/thumbnail-store";

const MAX_ATTEMPTS = 3;
/** Total tries a bookmark gets across every reopening, not per reopening. */
const MAX_REOPEN_ATTEMPTS = 6;

/**
 * Records a cover a capture surface observed in the browser. It is a hint, not
 * an answer: the job still prefers what it can discover server-side and falls
 * back to this only for pages the Worker cannot fetch itself.
 */
export async function setThumbnailCandidate(
  db: D1Database,
  jobId: string,
  candidateUrl: string,
): Promise<void> {
  if (isPlaceholderThumbnail(candidateUrl)) return;
  await db
    .prepare(
      `UPDATE thumbnail_jobs
          SET candidate_url = ?, updated_at = ?
        WHERE id = ? AND candidate_url IS NULL`,
    )
    .bind(candidateUrl, new Date().toISOString(), jobId)
    .run();
}

/**
 * Server-side page metadata first, then the capture hint, then icons. A real
 * page image from either source outranks a favicon.
 */
function orderedCandidates(
  discovered: ThumbnailCandidate[],
  hint: string | null,
): ThumbnailCandidate[] {
  const merged =
    hint === null
      ? discovered
      : [
          ...discovered.filter(candidate => candidate.source === "page_metadata"),
          { url: hint, source: "page_metadata" as const },
          ...discovered.filter(candidate => candidate.source !== "page_metadata"),
        ];
  return [...new Map(merged.map(candidate => [candidate.url, candidate])).values()];
}

type ThumbnailJobOutcome = "completed" | "retry" | "acknowledged";

/** Creates thumbnail job for thumbnail jobs. */
export async function createThumbnailJob(
  db: D1Database,
  bookmarkId: string,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO thumbnail_jobs (
         id, bookmark_id, state, created_at, updated_at
       ) VALUES (?, ?, 'pending_dispatch', ?, ?)`,
    )
    .bind(bookmarkId, bookmarkId, createdAt, createdAt)
    .run();
}

/** Repairs thumbnail backlog for thumbnail jobs. */
export async function repairThumbnailBacklog(env: Env): Promise<boolean> {
  const storage = await readThumbnailStorageState(env.DB);
  if (storage.mode === "disabled" || storage.status === "paused") return false;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'pending_dispatch',
                last_safe_error_code = 'stalled_job_recovered',
                updated_at = ?
          WHERE state IN ('queued', 'running') AND updated_at < ?`,
      )
      .bind(nowIso, staleBefore),
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO thumbnail_jobs (
           id, bookmark_id, state, created_at, updated_at
         )
         SELECT b.id, b.id, 'pending_dispatch', ?, ?
           FROM bookmarks b
          WHERE b.deleted_at IS NULL
            AND (b.thumbnail_id IS NULL OR b.title = b.hostname)`,
      )
      .bind(nowIso, nowIso),
    /*
     * Reopens work whose job row already exists and has stopped. Two cases the
     * insert above cannot reach, because INSERT OR IGNORE leaves a finished row
     * alone: a bookmark still showing its hostname as a title, and a cover that
     * gave up before derived candidates like YouTube's existed.
     *
     * `attempt_count` is deliberately not reset, and bounds the reopening. Some
     * pages legitimately have their hostname as their title, and some have no
     * usable cover at all; without the bound those would be rescanned on every
     * bootstrap forever. Carrying the count forward lets a stuck job get a few
     * more passes and then stop for good.
     */
    env.DB
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'pending_dispatch', next_attempt_at = NULL,
                completed_at = NULL, updated_at = ?
          WHERE state IN ('completed', 'failed')
            AND attempt_count < ?
            AND bookmark_id IN (
              SELECT b.id FROM bookmarks b
               WHERE b.deleted_at IS NULL
                 AND (b.title = b.hostname OR b.thumbnail_id IS NULL)
            )`,
      )
      .bind(nowIso, MAX_REOPEN_ATTEMPTS),
  ]);
  return (
    (await env.DB
      .prepare("SELECT 1 FROM thumbnail_jobs WHERE state = 'pending_dispatch' LIMIT 1")
      .first()) !== null
  );
}

/** Processes thumbnail job for thumbnail jobs. */
export async function processThumbnailJob(
  env: Env,
  jobId: string,
): Promise<ThumbnailJobOutcome> {
  const job = await env.DB
    .prepare(
      `SELECT j.state, j.attempt_count, j.candidate_url, b.id AS bookmark_id, b.url,
              b.deleted_at, b.thumbnail_id, (b.title = b.hostname) AS title_is_placeholder
         FROM thumbnail_jobs j
         JOIN bookmarks b ON b.id = j.bookmark_id
        WHERE j.id = ?`,
    )
    .bind(jobId)
    .first<{
      state: string;
      attempt_count: number;
      candidate_url: string | null;
      bookmark_id: string;
      url: string;
      deleted_at: string | null;
      thumbnail_id: string | null;
      title_is_placeholder: number;
    }>();
  if (job === null || ["completed", "cancelled", "failed"].includes(job.state)) {
    return "acknowledged";
  }

  const now = new Date().toISOString();
  const claimed = await env.DB
    .prepare(
      `UPDATE thumbnail_jobs
          SET state = 'running', attempt_count = attempt_count + 1,
              next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND state IN ('pending_dispatch', 'queued')`,
    )
    .bind(now, jobId)
    .run();
  if (claimed.meta.changes !== 1) return "acknowledged";

  const needsThumbnail = job.thumbnail_id === null;
  const needsTitle = job.title_is_placeholder === 1;
  // A bookmark that already has its cover can still be carrying a placeholder
  // title, so having a thumbnail is no longer on its own a reason to stop.
  if (job.deleted_at !== null || (!needsThumbnail && !needsTitle)) {
    await env.DB
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .bind(job.deleted_at === null ? "completed" : "cancelled", now, now, jobId)
      .run();
    return "completed";
  }

  const scan = await scanPageForThumbnail(job.url);
  /*
   * The iOS Share Sheet can only send a URL, so those bookmarks are created
   * titled with their hostname — "youtube.com" — and nothing else ever replaced
   * it. This job already has the page open, and unlike AI organization it does
   * not depend on a provider, so a share-sheet capture gets its real title even
   * while AI is paused or out of allowance. The hostname comparison is what
   * keeps a title the owner or the extension supplied from being overwritten.
   */
  if (scan.pageTitle !== null) {
    /*
     * Deliberately does not touch `revision`.
     *
     * `revision` is the token the organization pipeline holds across an AI call
     * that takes tens of seconds: it writes its result back only if the number
     * still matches, so that a bookmark the owner edited meanwhile is not
     * overwritten by a decision made about an older candidate. This job runs
     * concurrently with that call and would move the number underneath it —
     * every result then landed on zero rows, was recorded as
     * `stale_ai_result_recovered`, and requeued for five minutes. The bookmark
     * sat in Unsorted the whole time, and because that outcome is a retry the
     * dashboard was never told anything had happened.
     *
     * Filling in a placeholder title is a repair, not an edit competing with
     * the owner's, so it has no business invalidating anyone's revision.
     */
    await env.DB
      .prepare(
        `UPDATE bookmarks
            SET title = ?, modified_at = ?
          WHERE id = ? AND deleted_at IS NULL AND title = hostname`,
      )
      .bind(scan.pageTitle, new Date().toISOString(), job.bookmark_id)
      .run();
  }

  const candidates = needsThumbnail
    ? orderedCandidates(scan.candidates, job.candidate_url)
    : [];
  for (const candidate of candidates) {
    const outcome = await ingestThumbnailCandidate(
      env,
      job.bookmark_id,
      candidate.url,
      candidate.source,
    );
    if (outcome === "stored") {
      const completedAt = new Date().toISOString();
      await env.DB
        .prepare(
          `UPDATE thumbnail_jobs
              SET state = 'completed', last_safe_error_code = NULL,
                  completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .bind(completedAt, completedAt, jobId)
        .run();
      return "completed";
    }
    if (outcome === "storage_disabled" || outcome === "storage_paused") {
      const completedAt = new Date().toISOString();
      await env.DB
        .prepare(
          `UPDATE thumbnail_jobs
              SET state = ?, last_safe_error_code = ?,
                  completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .bind(
          outcome === "storage_disabled" ? "cancelled" : "paused_storage",
          outcome === "storage_disabled"
            ? "thumbnail_storage_disabled"
            : "thumbnail_storage_unavailable",
          outcome === "storage_disabled" ? completedAt : null,
          completedAt,
          jobId,
        )
        .run();
      return "acknowledged";
    }
  }
  // A run that was only ever about the title has nothing left to retry for.
  if (!needsThumbnail) {
    const completedAt = new Date().toISOString();
    await env.DB
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'completed', completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .bind(completedAt, completedAt, jobId)
      .run();
    return "completed";
  }

  const attemptCount = job.attempt_count + 1;
  if (attemptCount >= MAX_ATTEMPTS) {
    const failedAt = new Date().toISOString();
    await env.DB
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'failed', last_safe_error_code = 'thumbnail_unavailable',
                completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .bind(failedAt, failedAt, jobId)
      .run();
    return "completed";
  }

  const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await env.DB
    .prepare(
      `UPDATE thumbnail_jobs
          SET state = 'queued', next_attempt_at = ?,
              last_safe_error_code = 'thumbnail_fetch_retry', updated_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .bind(retryAt, new Date().toISOString(), jobId)
    .run();
  return "retry";
}
