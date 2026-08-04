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
  "'pending_dispatch', 'queued', 'running', 'waiting_provider', 'paused_edit', 'paused_owner'";

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
 * Repairs legacy global-edit pauses and bookmarks left pending without a live
 * job. It is idempotent so an authenticated bootstrap can safely trigger it.
 */
export async function repairOrganizationBacklog(env: Env): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

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
        `UPDATE app_state
            SET edit_mode_state = 'inactive',
                edit_mode_session_id = NULL,
                edit_mode_expires_at = NULL,
                updated_at = ?
          WHERE id = 1 AND edit_mode_state != 'inactive'`,
      )
      .bind(nowIso),
    env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = CASE
                  WHEN (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 1
                    THEN 'paused_owner'
                  WHEN (SELECT operational_status FROM provider_settings WHERE id = 1) = 'waiting'
                    THEN 'waiting_provider'
                  ELSE 'pending_dispatch'
                END,
                organization_generation = (
                  SELECT organization_generation FROM app_state WHERE id = 1
                ),
                updated_at = ?
          WHERE state = 'paused_edit'`,
      )
      .bind(nowIso),
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET ai_state = CASE
                  WHEN (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 1
                    THEN 'paused_owner'
                  WHEN (SELECT operational_status FROM provider_settings WHERE id = 1) = 'waiting'
                    THEN 'waiting_provider'
                  ELSE 'pending'
                END
          WHERE ai_state = 'paused_edit'`,
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
          AND b.ai_state IN ('pending', 'processing', 'paused_edit')
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
