type QueueTable = "background_jobs" | "thumbnail_jobs";

/** Sends one job message and marks the corresponding pending D1 row as queued. */
async function dispatchPendingJob(
  db: D1Database,
  queue: Queue,
  table: QueueTable,
  jobId: string,
  message: object,
): Promise<boolean> {
  try {
    await queue.send(message);
    await db
      .prepare(
        `UPDATE ${table}
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

/** Dispatches an organization job without putting bookmark content on the Queue. */
export function dispatchJob(db: D1Database, queue: Queue, jobId: string): Promise<boolean> {
  return dispatchPendingJob(db, queue, "background_jobs", jobId, {
    type: "organize",
    jobId,
  });
}

/** Dispatches a thumbnail job independently from organization work. */
export function dispatchThumbnailJob(
  db: D1Database,
  queue: Queue,
  jobId: string,
): Promise<boolean> {
  return dispatchPendingJob(db, queue, "thumbnail_jobs", jobId, {
    type: "thumbnail",
    jobId,
  });
}
