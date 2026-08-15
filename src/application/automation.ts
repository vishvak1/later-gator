interface RecoverableBookmark {
  id: string;
  revision: number;
  organization_generation: number;
  provider: string;
  model: string;
  job_state: "pending_dispatch" | "paused_owner" | "waiting_provider";
  bookmark_state: "pending" | "paused_owner" | "waiting_provider";
}

const ACTIVE_JOB_STATES =
  "'pending_dispatch', 'queued', 'running', 'waiting_provider', 'paused_owner'";

/** Serializes recoverable bookmarks for a set-based D1 job insert. */
function recoveryJobRows(bookmarks: RecoverableBookmark[]): string {
  return JSON.stringify(
    bookmarks.map((bookmark) => ({
      id: crypto.randomUUID(),
      bookmarkId: bookmark.id,
      state: bookmark.job_state,
      expectedRevision: bookmark.revision,
      generation: bookmark.organization_generation,
      provider: bookmark.provider,
      model: bookmark.model,
      idempotencyKey: `recovery:${bookmark.id}:${bookmark.revision.toString()}:${crypto.randomUUID()}`,
      bookmarkState: bookmark.bookmark_state,
    })),
  );
}

/**
 * Repairs stalled organization jobs and pending bookmarks that have no live
 * job. It is idempotent so authenticated bootstrap can safely trigger it.
 */
export async function repairOrganizationBacklog(env: Env): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

  /*
   * Lift an allowance pause whose retry time has arrived. A spent Workers AI
   * daily allowance comes back on its own, but nothing used to notice: the
   * provider stayed 'waiting' until the owner pressed "Test and activate", so a
   * library sat unorganized for as long as it took someone to go and look.
   *
   * This runs before the sweeps below so that, in the same pass, the jobs it
   * releases are then re-queued by them.
   */
  await env.DB
    .prepare(
      `UPDATE provider_settings
          SET operational_status = 'ready', last_safe_error_code = NULL,
              retry_after = NULL, updated_at = ?
        WHERE id = 1
          AND operational_status = 'waiting'
          AND retry_after IS NOT NULL
          AND retry_after <= ?`,
    )
    .bind(nowIso, nowIso)
    .run();

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET folder_id = 'folder_need_review',
                modified_at = ?,
                revision = revision + 1
          WHERE deleted_at IS NULL
            AND folder_id = 'folder_unsorted'
            AND ai_state IN ('review', 'failed')`,
      )
      .bind(nowIso),
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET organization_policy = 'full',
                ai_state = CASE
                  WHEN (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 1
                    THEN 'paused_owner'
                  WHEN (SELECT operational_status FROM provider_settings WHERE id = 1) = 'waiting'
                    THEN 'waiting_provider'
                  ELSE 'pending'
                END
          WHERE deleted_at IS NULL
            AND folder_id = 'folder_unsorted'
            AND (organization_policy = 'none' OR ai_state = 'complete')`,
      ),
    env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = 'pending_dispatch',
                organization_generation = (
                  SELECT organization_generation FROM app_state WHERE id = 1
                ),
                last_safe_error_code = 'stalled_job_recovered',
                updated_at = ?
          WHERE state IN ('queued', 'running')
            AND updated_at < ?
            AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0
            AND (SELECT operational_status FROM provider_settings WHERE id = 1) != 'waiting'`,
      )
      .bind(nowIso, staleBefore),
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET ai_state = 'pending'
          WHERE ai_state = 'processing'
            AND id IN (
              SELECT bookmark_id
                FROM background_jobs
               WHERE state = 'pending_dispatch'
                 AND last_safe_error_code = 'stalled_job_recovered'
            )`,
      ),
    /*
     * Release everything parked on the provider once the provider is usable
     * again. Previously only /api/providers/activate did this, which is why a
     * recovered allowance still needed the owner to press "Test and activate":
     * the status could go back to ready while every job stayed waiting on it.
     */
    env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = 'pending_dispatch', last_safe_error_code = NULL, updated_at = ?
          WHERE state = 'waiting_provider'
            AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0
            AND (SELECT operational_status FROM provider_settings WHERE id = 1) != 'waiting'`,
      )
      .bind(nowIso),
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET ai_state = 'pending'
          WHERE ai_state = 'waiting_provider'
            AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0
            AND (SELECT operational_status FROM provider_settings WHERE id = 1) != 'waiting'`,
      ),
  ]);

  const recoverable = await env.DB
    .prepare(
      `SELECT b.id,
              b.revision,
              s.organization_generation,
              p.provider,
              p.model,
              CASE
                WHEN s.owner_ai_paused = 1 THEN 'paused_owner'
                WHEN p.operational_status = 'waiting' THEN 'waiting_provider'
                ELSE 'pending_dispatch'
              END AS job_state,
              CASE
                WHEN s.owner_ai_paused = 1 THEN 'paused_owner'
                WHEN p.operational_status = 'waiting' THEN 'waiting_provider'
                ELSE 'pending'
              END AS bookmark_state
         FROM bookmarks b
         JOIN app_state s ON s.id = 1
         JOIN provider_settings p ON p.id = 1
        WHERE b.deleted_at IS NULL
          AND b.folder_id = 'folder_unsorted'
          AND b.organization_policy IN ('full', 'preserve')
          AND b.ai_state IN ('pending', 'processing')
          AND NOT EXISTS (
            SELECT 1
              FROM background_jobs j
             WHERE j.bookmark_id = b.id
               AND j.state IN (${ACTIVE_JOB_STATES})
          )`,
    )
    .all<RecoverableBookmark>();

  if (recoverable.results.length > 0) {
    const rowsJson = recoveryJobRows(recoverable.results);
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO background_jobs (
             id, bookmark_id, state, expected_revision, organization_generation,
             provider, model, idempotency_key, created_at, updated_at
           )
           SELECT
             json_extract(value, '$.id'),
             json_extract(value, '$.bookmarkId'),
             json_extract(value, '$.state'),
             json_extract(value, '$.expectedRevision'),
             json_extract(value, '$.generation'),
             json_extract(value, '$.provider'),
             json_extract(value, '$.model'),
             json_extract(value, '$.idempotencyKey'),
             ?,
             ?
           FROM json_each(?)`,
        )
        .bind(nowIso, nowIso, rowsJson),
      env.DB
        .prepare(
          `UPDATE bookmarks
              SET ai_state = (
                SELECT json_extract(value, '$.bookmarkState')
                  FROM json_each(?)
                 WHERE json_extract(value, '$.bookmarkId') = bookmarks.id
              )
            WHERE id IN (
              SELECT json_extract(value, '$.bookmarkId') FROM json_each(?)
            )`,
        )
        .bind(rowsJson, rowsJson),
    ]);
  }

  const pending = await env.DB
    .prepare("SELECT 1 FROM background_jobs WHERE state = 'pending_dispatch' LIMIT 1")
    .first();
  return pending !== null;
}
