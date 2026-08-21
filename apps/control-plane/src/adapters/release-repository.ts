export interface UpdatableInstallation {
  id: string;
  ownerId: string;
  accountId: string;
  storageMode: "kv" | "r2";
  workerOrigin: string;
  installedRelease: string;
  desiredRelease: string;
  rolloutCohort: number;
  currentVersionId: string;
}

/** Loads one ready installation without any personal application data. */
export async function findUpdatableInstallation(
  database: D1Database,
  ownerId: string,
): Promise<UpdatableInstallation | null> {
  const row = await database.prepare(
    `SELECT i.id, i.owner_id, i.account_id, i.storage_mode, i.installed_release,
            i.desired_release, i.rollout_cohort, i.current_version_id, m.worker_origin
       FROM installations i
       JOIN installation_runtime_metadata m ON m.installation_id = i.id
      WHERE i.owner_id = ? AND i.status = 'ready'`,
  ).bind(ownerId).first<{
    id: string;
    owner_id: string;
    account_id: string;
    storage_mode: string;
    installed_release: string | null;
    desired_release: string;
    rollout_cohort: number;
    current_version_id: string | null;
    worker_origin: string;
  }>();
  if (
    row?.installed_release == null ||
    row.current_version_id === null ||
    (row.storage_mode !== "kv" && row.storage_mode !== "r2")
  ) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    accountId: row.account_id,
    storageMode: row.storage_mode,
    workerOrigin: row.worker_origin,
    installedRelease: row.installed_release,
    desiredRelease: row.desired_release,
    rolloutCohort: row.rollout_cohort,
    currentVersionId: row.current_version_id,
  };
}

/** Creates or advances an operator-controlled cohort campaign. */
export async function configureRolloutCampaign(
  database: D1Database,
  release: string,
  cohortCeiling: number,
  failureThresholdPercent: number,
  nowSeconds: number,
): Promise<void> {
  const state = cohortCeiling >= 100 ? "complete" : cohortCeiling <= 1 ? "canary" : "rolling";
  await database.prepare(
    `INSERT INTO rollout_campaigns (
       release, cohort_ceiling, state, failure_threshold_percent, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(release) DO UPDATE SET
       cohort_ceiling = excluded.cohort_ceiling,
       state = CASE WHEN rollout_campaigns.state = 'paused' THEN 'paused' ELSE excluded.state END,
       failure_threshold_percent = excluded.failure_threshold_percent,
       updated_at = excluded.updated_at`,
  ).bind(release, cohortCeiling, state, failureThresholdPercent, nowSeconds).run();
}

/** Returns whether one stable installation cohort is currently authorized to update. */
export async function installationInActiveCohort(
  database: D1Database,
  release: string,
  cohort: number,
): Promise<boolean> {
  const campaign = await database.prepare(
    "SELECT cohort_ceiling, state FROM rollout_campaigns WHERE release = ?",
  ).bind(release).first<{ cohort_ceiling: number; state: string }>();
  return campaign !== null && campaign.state !== "paused" && cohort < campaign.cohort_ceiling;
}

/** Starts or resumes the privacy-safe release history row for one installation. */
export async function startReleaseUpdate(
  database: D1Database,
  input: {
    installationId: string;
    release: string;
    artifactDigest: string;
    schemaVersion: number;
    previousVersionId: string;
    nowSeconds: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await database.batch([
    database.prepare(
      `INSERT INTO runtime_release_history (
         id, installation_id, release, artifact_digest, schema_version,
         previous_version_id, state, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
       ON CONFLICT(installation_id, release) DO UPDATE SET
         artifact_digest = excluded.artifact_digest,
         previous_version_id = excluded.previous_version_id,
         safe_error_code = NULL`,
    ).bind(
      id,
      input.installationId,
      input.release,
      input.artifactDigest,
      input.schemaVersion,
      input.previousVersionId,
      input.nowSeconds,
    ),
    database.prepare(
      `UPDATE installations SET desired_release = ?, update_status = 'queued', updated_at = ?
        WHERE id = ?`,
    ).bind(input.release, input.nowSeconds, input.installationId),
  ]);
  const stored = await database.prepare(
    "SELECT id FROM runtime_release_history WHERE installation_id = ? AND release = ?",
  ).bind(input.installationId, input.release).first<{ id: string }>();
  if (stored === null) throw new Error("release_history_unavailable");
  return stored.id;
}

/** Records a D1 Time Travel point and an idempotent migration checksum. */
export async function startControlMigration(
  database: D1Database,
  input: {
    installationId: string;
    migrationId: string;
    checksum: string;
    fromSchemaVersion: number;
    toSchemaVersion: number;
    phase: "expand" | "migrate" | "contract";
    bookmark: string;
    nowSeconds: number;
  },
): Promise<"run" | "complete"> {
  const existing = await database.prepare(
    `SELECT checksum, state FROM control_schema_migrations
      WHERE installation_id = ? AND migration_id = ?`,
  ).bind(input.installationId, input.migrationId).first<{ checksum: string; state: string }>();
  if (existing !== null) {
    if (existing.checksum !== input.checksum) throw new Error("migration_checksum_changed");
    if (existing.state === "complete") return "complete";
  }
  await database.prepare(
    `INSERT INTO control_schema_migrations (
       installation_id, migration_id, checksum, from_schema_version,
       to_schema_version, phase, time_travel_bookmark, state, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
     ON CONFLICT(installation_id, migration_id) DO UPDATE SET
       state = 'running', time_travel_bookmark = excluded.time_travel_bookmark,
       updated_at = excluded.updated_at`,
  ).bind(
    input.installationId,
    input.migrationId,
    input.checksum,
    input.fromSchemaVersion,
    input.toSchemaVersion,
    input.phase,
    input.bookmark,
    input.nowSeconds,
  ).run();
  return "run";
}

/** Completes one migration only after its entire D1 batch succeeds. */
export async function completeControlMigration(
  database: D1Database,
  installationId: string,
  migrationId: string,
  nowSeconds: number,
): Promise<void> {
  await database.prepare(
    `UPDATE control_schema_migrations SET state = 'complete', updated_at = ?
      WHERE installation_id = ? AND migration_id = ?`,
  ).bind(nowSeconds, installationId, migrationId).run();
}

/** Updates the safe release state machine without retaining provider responses. */
export async function setReleaseUpdateState(
  database: D1Database,
  installationId: string,
  release: string,
  state: "migrating" | "uploaded" | "healthy" | "promoted" | "failed" | "rolled_back",
  fields: {
    versionId?: string;
    deploymentId?: string;
    bookmark?: string;
    safeErrorCode?: string;
    nowSeconds: number;
  },
): Promise<void> {
  await database.prepare(
    `UPDATE runtime_release_history SET state = ?, version_id = COALESCE(?, version_id),
       deployment_id = COALESCE(?, deployment_id),
       time_travel_bookmark = COALESCE(?, time_travel_bookmark), safe_error_code = ?,
       completed_at = CASE WHEN ? IN ('promoted', 'failed', 'rolled_back') THEN ? ELSE completed_at END
     WHERE installation_id = ? AND release = ?`,
  ).bind(
    state,
    fields.versionId ?? null,
    fields.deploymentId ?? null,
    fields.bookmark ?? null,
    fields.safeErrorCode ?? null,
    state,
    fields.nowSeconds,
    installationId,
    release,
  ).run();
  const updateState = ({
    migrating: "migrating",
    uploaded: "uploading",
    healthy: "health_check",
    promoted: "complete",
    failed: "failed",
    rolled_back: "failed",
  } as const)[state];
  await database.prepare(
    "UPDATE installations SET update_status = ?, updated_at = ? WHERE id = ?",
  ).bind(updateState, fields.nowSeconds, installationId).run();
}

/** Commits promoted release metadata while retaining the rollback version ID. */
export async function completeReleasePromotion(
  database: D1Database,
  installation: UpdatableInstallation,
  release: string,
  versionId: string,
  nowSeconds: number,
): Promise<void> {
  await database.batch([
    database.prepare(
      `UPDATE installations SET installed_release = ?, desired_release = ?,
         previous_version_id = current_version_id, current_version_id = ?,
         update_status = 'complete', updated_at = ? WHERE id = ?`,
    ).bind(release, release, versionId, nowSeconds, installation.id),
    database.prepare(
      `UPDATE installation_runtime_metadata SET current_release = ?, health_status = 'ready',
         updated_at = ? WHERE installation_id = ?`,
    ).bind(release, nowSeconds, installation.id),
  ]);
}

/** Increments campaign outcomes and automatically pauses at the configured failure threshold. */
export async function recordRolloutOutcome(
  database: D1Database,
  release: string,
  failed: boolean,
  nowSeconds: number,
): Promise<void> {
  await database.prepare(
    `UPDATE rollout_campaigns SET attempted_count = attempted_count + 1,
       failure_count = failure_count + ?,
       state = CASE
         WHEN attempted_count + 1 >= 5 AND
              ((failure_count + ?) * 100 / (attempted_count + 1)) >= failure_threshold_percent
         THEN 'paused' ELSE state END,
       updated_at = ? WHERE release = ?`,
  ).bind(failed ? 1 : 0, failed ? 1 : 0, nowSeconds, release).run();
}
