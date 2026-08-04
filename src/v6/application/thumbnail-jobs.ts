import {
  findPageThumbnailCandidates,
  ingestThumbnailCandidate,
} from "./thumbnails";

const MAX_ATTEMPTS = 3;

type ThumbnailJobOutcome = "completed" | "retry" | "acknowledged";

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

export async function dispatchThumbnailJob(
  db: D1Database,
  queue: Queue,
  jobId: string,
): Promise<boolean> {
  try {
    await queue.send({ version: 1, type: "thumbnail", jobId });
    await db
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'queued', updated_at = ?
          WHERE id = ? AND state = 'pending_dispatch'`,
      )
      .bind(new Date().toISOString(), jobId)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function repairThumbnailBacklog(env: Env): Promise<boolean> {
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
            AND b.thumbnail_id IS NULL`,
      )
      .bind(nowIso, nowIso),
  ]);
  return (
    (await env.DB
      .prepare("SELECT 1 FROM thumbnail_jobs WHERE state = 'pending_dispatch' LIMIT 1")
      .first()) !== null
  );
}

export async function processThumbnailJob(
  env: Env,
  jobId: string,
): Promise<ThumbnailJobOutcome> {
  const job = await env.DB
    .prepare(
      `SELECT j.state, j.attempt_count, b.id AS bookmark_id, b.url,
              b.deleted_at, b.thumbnail_id
         FROM thumbnail_jobs j
         JOIN bookmarks b ON b.id = j.bookmark_id
        WHERE j.id = ?`,
    )
    .bind(jobId)
    .first<{
      state: string;
      attempt_count: number;
      bookmark_id: string;
      url: string;
      deleted_at: string | null;
      thumbnail_id: string | null;
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

  if (job.deleted_at !== null || job.thumbnail_id !== null) {
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

  const candidates = await findPageThumbnailCandidates(job.url);
  for (const candidate of candidates) {
    if (await ingestThumbnailCandidate(env, job.bookmark_id, candidate.url, candidate.source)) {
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
