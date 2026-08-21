export type ThumbnailStorageMode = "kv" | "r2";

export interface StoredInstallerRequest {
  codeVerifier: string;
  ownerId: string;
  requestedScopesJson: string;
  storageMode: ThumbnailStorageMode;
}

export interface InstallationSummary {
  status: "authorized" | "provisioning" | "waiting_for_r2" | "ready" | "failed" | "cleanup_pending";
  storageMode: ThumbnailStorageMode;
  safeErrorCode: string | null;
  installedRelease: string | null;
  desiredRelease: string;
  updateStatus: string;
  workerOrigin: string | null;
  authorizationActive: boolean;
}

export interface OwnerReleaseHistory {
  release: string;
  state: string;
  safeErrorCode: string | null;
  startedAt: number;
  completedAt: number | null;
}

export type ProvisioningStepCode =
  | "d1"
  | "oauth_kv"
  | "thumbnail_kv"
  | "thumbnail_r2"
  | "vectorize"
  | "background_queue"
  | "thumbnail_queue"
  | "runtime_secret"
  | "worker_upload"
  | "schema_initialize"
  | "queue_consumers"
  | "workers_dev"
  | "health_check";

export interface ProvisioningInstallation {
  id: string;
  ownerId: string;
  accountId: string;
  storageMode: ThumbnailStorageMode;
  status: InstallationSummary["status"];
  currentStep: ProvisioningStepCode;
}

export interface InstallationResource {
  type: "d1" | "oauth_kv" | "thumbnail_kv" | "thumbnail_r2" | "vectorize" |
    "background_queue" | "thumbnail_queue" | "worker";
  name: string;
  id: string;
}

export interface CleanupInstallation {
  id: string;
  accountId: string;
  status: InstallationSummary["status"];
}

export interface RuntimeLoginTarget {
  ownerId: string;
  workerOrigin: string;
}

export interface StoredRuntimeLoginRequest {
  callbackUrl: string;
  installationId: string;
  nonce: string;
  runtimeState: string;
}

/** Reads only owner-visible installation status and storage mode. */
export async function findOwnerInstallationSummary(
  database: D1Database,
  ownerId: string,
): Promise<InstallationSummary | null> {
  const detailed = await database.prepare(
    `SELECT i.status, i.storage_mode, i.safe_error_code, i.installed_release,
            i.desired_release, i.update_status, m.worker_origin,
            EXISTS(SELECT 1 FROM installer_authorizations a
              WHERE a.owner_id = i.owner_id AND a.revoked_at IS NULL) AS authorization_active
       FROM installations i
       LEFT JOIN installation_runtime_metadata m ON m.installation_id = i.id
      WHERE i.owner_id = ?`,
  ).bind(ownerId).first<{
    status: InstallationSummary["status"];
    storage_mode: string;
    safe_error_code: string | null;
    installed_release: string | null;
    desired_release: string;
    update_status: string;
    worker_origin: string | null;
    authorization_active: number;
  }>();
  if (detailed === null || (detailed.storage_mode !== "kv" && detailed.storage_mode !== "r2")) {
    return null;
  }
  return {
    status: detailed.status,
    storageMode: detailed.storage_mode,
    safeErrorCode: detailed.safe_error_code,
    installedRelease: detailed.installed_release,
    desiredRelease: detailed.desired_release,
    updateStatus: detailed.update_status,
    workerOrigin: detailed.worker_origin,
    authorizationActive: detailed.authorization_active === 1,
  };
}

/** Resolves one ready installation without exposing unrelated owner metadata. */
export async function findRuntimeLoginTarget(
  database: D1Database,
  installationId: string,
): Promise<RuntimeLoginTarget | null> {
  const row = await database.prepare(
    `SELECT i.owner_id, m.worker_origin
       FROM installations i
       JOIN installation_runtime_metadata m ON m.installation_id = i.id
      WHERE i.id = ? AND i.status = 'ready' AND m.health_status = 'ready'`,
  ).bind(installationId).first<{ owner_id: string; worker_origin: string }>();
  return row === null ? null : { ownerId: row.owner_id, workerOrigin: row.worker_origin };
}

/** Stores one short-lived personal-runtime login continuation before identity redirect. */
export async function storeRuntimeLoginRequest(
  database: D1Database,
  input: {
    requestHash: string;
    ownerId: string;
    installationId: string;
    callbackUrl: string;
    nonce: string;
    runtimeState: string;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> {
  await database.batch([
    database.prepare(
      "DELETE FROM runtime_login_requests WHERE expires_at < ?",
    ).bind(input.createdAt),
    database.prepare(
      `INSERT INTO runtime_login_requests (
         request_hash, owner_id, installation_id, callback_url, nonce,
         runtime_state, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.requestHash,
      input.ownerId,
      input.installationId,
      input.callbackUrl,
      input.nonce,
      input.runtimeState,
      input.createdAt,
      input.expiresAt,
    ),
  ]);
}

/** Atomically consumes one continuation only for its installation owner. */
export async function consumeRuntimeLoginRequest(
  database: D1Database,
  requestHash: string,
  ownerId: string,
  nowSeconds: number,
): Promise<StoredRuntimeLoginRequest | null> {
  const row = await database.prepare(
    `UPDATE runtime_login_requests
        SET consumed_at = ?
      WHERE request_hash = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at >= ?
      RETURNING callback_url, installation_id, nonce, runtime_state`,
  ).bind(nowSeconds, requestHash, ownerId, nowSeconds).first<{
    callback_url: string;
    installation_id: string;
    nonce: string;
    runtime_state: string;
  }>();
  return row === null ? null : {
    callbackUrl: row.callback_url,
    installationId: row.installation_id,
    nonce: row.nonce,
    runtimeState: row.runtime_state,
  };
}

/** Lists recent privacy-safe update outcomes for one owner's installation. */
export async function findOwnerReleaseHistory(
  database: D1Database,
  ownerId: string,
): Promise<OwnerReleaseHistory[]> {
  const rows = await database.prepare(
    `SELECT h.release, h.state, h.safe_error_code, h.started_at, h.completed_at
       FROM runtime_release_history h
       JOIN installations i ON i.id = h.installation_id
      WHERE i.owner_id = ? ORDER BY h.started_at DESC LIMIT 10`,
  ).bind(ownerId).all<{
    release: string;
    state: string;
    safe_error_code: string | null;
    started_at: number;
    completed_at: number | null;
  }>();
  return rows.results.map((row) => ({
    release: row.release,
    state: row.state,
    safeErrorCode: row.safe_error_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

/** Stores an immutable, short-lived installer consent request. */
export async function storeInstallerRequest(
  database: D1Database,
  input: {
    stateHash: string;
    ownerId: string;
    codeVerifier: string;
    storageMode: ThumbnailStorageMode;
    requestedScopesJson: string;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO oauth_installer_requests (
        state_hash, owner_id, code_verifier, storage_mode,
        requested_scopes_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.stateHash,
      input.ownerId,
      input.codeVerifier,
      input.storageMode,
      input.requestedScopesJson,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}

/** Atomically consumes a same-owner installer request to reject callback replay. */
export async function consumeInstallerRequest(
  database: D1Database,
  stateHash: string,
  ownerId: string,
  nowSeconds: number,
): Promise<StoredInstallerRequest | null> {
  const row = await database
    .prepare(
      `UPDATE oauth_installer_requests
          SET consumed_at = ?
        WHERE state_hash = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at >= ?
        RETURNING code_verifier, owner_id, storage_mode, requested_scopes_json`,
    )
    .bind(nowSeconds, stateHash, ownerId, nowSeconds)
    .first<{
      code_verifier: string;
      owner_id: string;
      storage_mode: string;
      requested_scopes_json: string;
    }>();
  if (row === null || (row.storage_mode !== "kv" && row.storage_mode !== "r2")) return null;
  return {
    codeVerifier: row.code_verifier,
    ownerId: row.owner_id,
    requestedScopesJson: row.requested_scopes_json,
    storageMode: row.storage_mode,
  };
}

/** Retrieves the one-way Cloudflare subject binding for callback-owner comparison. */
export async function findOwnerSubjectHash(
  database: D1Database,
  ownerId: string,
): Promise<string | null> {
  const row = await database
    .prepare("SELECT subject_hash FROM owners WHERE id = ?")
    .bind(ownerId)
    .first<{ subject_hash: string }>();
  return row?.subject_hash ?? null;
}

/** Stores one encrypted renewable authorization and its safe management metadata. */
export async function storeInstallerAuthorization(
  database: D1Database,
  input: {
    ownerId: string;
    accountId: string;
    ciphertext: string;
    nonce: string;
    grantedScopesJson: string;
    expiresAt: number;
    updatedAt: number;
  },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO installer_authorizations (
        owner_id, account_id, token_ciphertext, token_nonce, schema_version,
        granted_scopes_json, token_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        account_id = excluded.account_id,
        token_ciphertext = excluded.token_ciphertext,
        token_nonce = excluded.token_nonce,
        schema_version = 1,
        granted_scopes_json = excluded.granted_scopes_json,
        token_expires_at = excluded.token_expires_at,
        updated_at = excluded.updated_at,
        revoked_at = NULL`,
    )
    .bind(
      input.ownerId,
      input.accountId,
      input.ciphertext,
      input.nonce,
      input.grantedScopesJson,
      input.expiresAt,
      input.updatedAt,
    )
    .run();
}

/** Creates one installation and its immutable requested-resource plan idempotently. */
export async function createAuthorizedInstallation(
  database: D1Database,
  input: {
    installationId: string;
    ownerId: string;
    accountId: string;
    storageMode: ThumbnailStorageMode;
    requestedPlanJson: string;
    nowSeconds: number;
  },
): Promise<string> {
  const steps: ProvisioningStepCode[] = [
    "d1",
    "oauth_kv",
    input.storageMode === "kv" ? "thumbnail_kv" : "thumbnail_r2",
    "vectorize",
    "background_queue",
    "thumbnail_queue",
    "runtime_secret",
    "worker_upload",
    "schema_initialize",
    "queue_consumers",
    "workers_dev",
    "health_check",
  ];
  /** Backfills the immutable step ledger for pre-state-machine authorizations. */
  const ensureSteps = async (installationId: string): Promise<void> => {
    await database.batch(steps.map((step) => database.prepare(
      `INSERT OR IGNORE INTO provisioning_steps (
        installation_id, step_code, status, updated_at
      ) VALUES (?, ?, 'pending', ?)`,
    ).bind(installationId, step, input.nowSeconds)));
  };
  const existing = await database
    .prepare(
      `SELECT id, account_id, storage_mode, requested_plan_json
         FROM installations WHERE owner_id = ?`,
    )
    .bind(input.ownerId)
    .first<{
      id: string;
      account_id: string;
      storage_mode: string;
      requested_plan_json: string;
    }>();
  if (existing !== null) {
    if (
      existing.account_id !== input.accountId ||
      existing.storage_mode !== input.storageMode ||
      existing.requested_plan_json !== input.requestedPlanJson
    ) {
      throw new Error("installation_plan_conflict");
    }
    await database
      .prepare("UPDATE installations SET updated_at = ? WHERE id = ?")
      .bind(input.nowSeconds, existing.id)
      .run();
    await ensureSteps(existing.id);
    return existing.id;
  }
  const row = await database
    .prepare(
      `INSERT INTO installations (
        id, owner_id, account_id, storage_mode, requested_plan_json,
        status, current_step, rollout_cohort, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'authorized', 'd1', ?, ?, ?)
      RETURNING id`,
    )
    .bind(
      input.installationId,
      input.ownerId,
      input.accountId,
      input.storageMode,
      input.requestedPlanJson,
      Number.parseInt(input.installationId.replaceAll("-", "").slice(0, 8), 16) % 100,
      input.nowSeconds,
      input.nowSeconds,
    )
    .first<{ id: string }>();
  if (row === null) throw new Error("installation_create_failed");
  await ensureSteps(row.id);
  return row.id;
}

/** Loads the same-owner installation that one resumable provisioning request may advance. */
export async function findProvisioningInstallation(
  database: D1Database,
  ownerId: string,
): Promise<ProvisioningInstallation | null> {
  const row = await database.prepare(
    `SELECT id, owner_id, account_id, storage_mode, status, current_step
       FROM installations WHERE owner_id = ?`,
  ).bind(ownerId).first<{
    id: string;
    owner_id: string;
    account_id: string;
    storage_mode: string;
    status: InstallationSummary["status"];
    current_step: ProvisioningStepCode;
  }>();
  if (row === null || (row.storage_mode !== "kv" && row.storage_mode !== "r2")) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    accountId: row.account_id,
    storageMode: row.storage_mode,
    status: row.status,
    currentStep: row.current_step,
  };
}

/** Retrieves the active encrypted installer authorization without exposing it to routes. */
export async function findInstallerAuthorization(
  database: D1Database,
  ownerId: string,
): Promise<{
  accountId: string;
  ciphertext: string;
  nonce: string;
  expiresAt: number;
  grantedScopesJson: string;
} | null> {
  const row = await database.prepare(
    `SELECT account_id, token_ciphertext, token_nonce, token_expires_at, granted_scopes_json
       FROM installer_authorizations WHERE owner_id = ? AND revoked_at IS NULL`,
  ).bind(ownerId).first<{
    account_id: string;
    token_ciphertext: string;
    token_nonce: string;
    token_expires_at: number;
    granted_scopes_json: string;
  }>();
  return row === null ? null : {
    accountId: row.account_id,
    ciphertext: row.token_ciphertext,
    nonce: row.token_nonce,
    expiresAt: row.token_expires_at,
    grantedScopesJson: row.granted_scopes_json,
  };
}

/** Revokes the local installer authorization so no future Cloudflare mutation can start. */
export async function revokeInstallerAuthorization(
  database: D1Database,
  ownerId: string,
  nowSeconds: number,
): Promise<void> {
  await database.prepare(
    "UPDATE installer_authorizations SET revoked_at = ?, updated_at = ? WHERE owner_id = ?",
  ).bind(nowSeconds, nowSeconds, ownerId).run();
}

/** Returns one previously recorded resource so retries reuse rather than duplicate it. */
export async function findInstallationResource(
  database: D1Database,
  installationId: string,
  type: InstallationResource["type"],
): Promise<InstallationResource | null> {
  const row = await database.prepare(
    `SELECT resource_type, resource_name, resource_id FROM installation_resources
      WHERE installation_id = ? AND resource_type = ? AND status = 'active'`,
  ).bind(installationId, type).first<{
    resource_type: InstallationResource["type"];
    resource_name: string;
    resource_id: string;
  }>();
  return row === null ? null : { type: row.resource_type, name: row.resource_name, id: row.resource_id };
}

/** Records one deterministic resource immediately after Cloudflare confirms it exists. */
export async function recordInstallationResource(
  database: D1Database,
  installationId: string,
  resource: InstallationResource,
  nowSeconds: number,
): Promise<void> {
  await database.prepare(
    `INSERT INTO installation_resources (
       installation_id, resource_type, resource_name, resource_id,
       created_by_later_gator, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)
     ON CONFLICT(installation_id, resource_type) DO UPDATE SET
       resource_name = excluded.resource_name,
       resource_id = excluded.resource_id,
       status = 'active',
       updated_at = excluded.updated_at`,
  ).bind(
    installationId,
    resource.type,
    resource.name,
    resource.id,
    nowSeconds,
    nowSeconds,
  ).run();
}

/** Claims a pending or failed step once, preventing duplicate-click execution. */
export async function claimProvisioningStep(
  database: D1Database,
  installationId: string,
  step: ProvisioningStepCode,
  nowSeconds: number,
): Promise<boolean> {
  const row = await database.prepare(
    `UPDATE provisioning_steps
        SET status = 'running', attempt_count = attempt_count + 1,
            safe_error_code = NULL, updated_at = ?
      WHERE installation_id = ? AND step_code = ? AND status IN ('pending', 'failed')
      RETURNING step_code`,
  ).bind(nowSeconds, installationId, step).first<{ step_code: string }>();
  if (row === null) return false;
  await database.prepare(
    `UPDATE installations SET status = 'provisioning', current_step = ?,
       safe_error_code = NULL, updated_at = ? WHERE id = ?`,
  ).bind(step, nowSeconds, installationId).run();
  return true;
}

/** Reads one safe step status so concurrent duplicate requests can stop cleanly. */
export async function findProvisioningStepStatus(
  database: D1Database,
  installationId: string,
  step: ProvisioningStepCode,
): Promise<"pending" | "running" | "complete" | "failed" | null> {
  const row = await database.prepare(
    "SELECT status FROM provisioning_steps WHERE installation_id = ? AND step_code = ?",
  ).bind(installationId, step).first<{
    status: "pending" | "running" | "complete" | "failed";
  }>();
  return row?.status ?? null;
}

/** Restores one immutable provider identifier from a previously completed step. */
export async function findCompletedProvisioningStepResourceId(
  database: D1Database,
  installationId: string,
  step: ProvisioningStepCode,
): Promise<string | null> {
  const row = await database.prepare(
    `SELECT resource_id FROM provisioning_steps
      WHERE installation_id = ? AND step_code = ? AND status = 'complete'`,
  ).bind(installationId, step).first<{ resource_id: string | null }>();
  return row?.resource_id ?? null;
}

/** Reopens only Worker-dependent steps after an out-of-band Worker deletion. */
export async function reopenProvisioningAfterMissingWorker(
  database: D1Database,
  installationId: string,
  nowSeconds: number,
): Promise<void> {
  await database.batch([
    database.prepare(
      `UPDATE provisioning_steps
          SET status = 'pending', resource_id = NULL, safe_error_code = NULL, updated_at = ?
        WHERE installation_id = ? AND step_code IN (
          'worker_upload', 'queue_consumers', 'workers_dev', 'health_check'
        )`,
    ).bind(nowSeconds, installationId),
    database.prepare(
      `UPDATE installations
          SET status = 'authorized', current_step = 'worker_upload', safe_error_code = NULL,
              installed_release = NULL, current_version_id = NULL, update_status = 'idle',
              updated_at = ?
        WHERE id = ? AND status <> 'ready'`,
    ).bind(nowSeconds, installationId),
  ]);
}

/** Completes one provisioning step and advances the installation cursor. */
export async function completeProvisioningStep(
  database: D1Database,
  installationId: string,
  step: ProvisioningStepCode,
  nextStep: ProvisioningStepCode | null,
  resourceId: string | null,
  nowSeconds: number,
): Promise<void> {
  await database.batch([
    database.prepare(
      `UPDATE provisioning_steps SET status = 'complete', resource_id = ?,
         safe_error_code = NULL, updated_at = ?
       WHERE installation_id = ? AND step_code = ?`,
    ).bind(resourceId, nowSeconds, installationId, step),
    database.prepare(
      `UPDATE installations SET current_step = ?, updated_at = ? WHERE id = ?`,
    ).bind(nextStep ?? step, nowSeconds, installationId),
  ]);
}

/** Repairs the completed upload ledger with Cloudflare's immutable Worker version id. */
export async function recordProvisionedWorkerVersion(
  database: D1Database,
  installationId: string,
  versionId: string,
  nowSeconds: number,
): Promise<void> {
  await database.prepare(
    `UPDATE provisioning_steps SET resource_id = ?, updated_at = ?
      WHERE installation_id = ? AND step_code = 'worker_upload' AND status = 'complete'`,
  ).bind(versionId, nowSeconds, installationId).run();
}

/** Persists only an approved safe failure code and optionally pauses for R2 checkout. */
export async function failProvisioningStep(
  database: D1Database,
  installationId: string,
  step: ProvisioningStepCode,
  safeErrorCode: string,
  waitingForR2: boolean,
  nowSeconds: number,
): Promise<void> {
  await database.batch([
    database.prepare(
      `UPDATE provisioning_steps SET status = 'failed', safe_error_code = ?, updated_at = ?
        WHERE installation_id = ? AND step_code = ?`,
    ).bind(safeErrorCode, nowSeconds, installationId, step),
    database.prepare(
      `UPDATE installations SET status = ?, safe_error_code = ?, updated_at = ? WHERE id = ?`,
    ).bind(waitingForR2 ? "waiting_for_r2" : "failed", safeErrorCode, nowSeconds, installationId),
  ]);
}

/** Marks the installation ready only after its public health contract passes. */
export async function markInstallationReady(
  database: D1Database,
  installationId: string,
  workerOrigin: string,
  release: string,
  versionId: string,
  artifactDigest: string,
  schemaVersion: number,
  nowSeconds: number,
): Promise<void> {
  await database.batch([
    database.prepare(
      `INSERT INTO installation_runtime_metadata (
         installation_id, worker_origin, current_release, health_status, updated_at
       ) VALUES (?, ?, ?, 'ready', ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         worker_origin = excluded.worker_origin,
         current_release = excluded.current_release,
         health_status = 'ready',
         updated_at = excluded.updated_at`,
    ).bind(installationId, workerOrigin, release, nowSeconds),
    database.prepare(
      `UPDATE installations SET status = 'ready', safe_error_code = NULL,
         installed_release = ?, desired_release = ?, update_status = 'complete',
         current_version_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(release, release, versionId, nowSeconds, installationId),
    database.prepare(
      `INSERT INTO runtime_release_history (
         id, installation_id, release, artifact_digest, schema_version,
         version_id, state, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'promoted', ?, ?)
       ON CONFLICT(installation_id, release) DO UPDATE SET
         artifact_digest = excluded.artifact_digest,
         schema_version = excluded.schema_version,
         version_id = excluded.version_id,
         state = 'promoted', safe_error_code = NULL,
         completed_at = excluded.completed_at`,
    ).bind(
      crypto.randomUUID(),
      installationId,
      release,
      artifactDigest,
      schemaVersion,
      versionId,
      nowSeconds,
      nowSeconds,
    ),
  ]);
}

/** Loads one owner installation eligible for explicitly confirmed compensating cleanup. */
export async function findCleanupInstallation(
  database: D1Database,
  ownerId: string,
): Promise<CleanupInstallation | null> {
  const row = await database.prepare(
    "SELECT id, account_id, status FROM installations WHERE owner_id = ?",
  ).bind(ownerId).first<{
    id: string;
    account_id: string;
    status: InstallationSummary["status"];
  }>();
  return row === null ? null : { id: row.id, accountId: row.account_id, status: row.status };
}

/** Marks a non-ready installation and only its Later-Gator-created resources for cleanup. */
export async function beginInstallationCleanup(
  database: D1Database,
  installationId: string,
  nowSeconds: number,
): Promise<void> {
  await database.batch([
    database.prepare(
      `UPDATE installations SET status = 'cleanup_pending', safe_error_code = NULL, updated_at = ?
        WHERE id = ? AND status <> 'ready'`,
    ).bind(nowSeconds, installationId),
    database.prepare(
      `UPDATE installation_resources SET status = 'cleanup_pending', updated_at = ?
        WHERE installation_id = ? AND created_by_later_gator = 1 AND status = 'active'`,
    ).bind(nowSeconds, installationId),
  ]);
}

/** Lists only explicitly owned resources still requiring compensating deletion. */
export async function listCleanupResources(
  database: D1Database,
  installationId: string,
): Promise<InstallationResource[]> {
  const rows = await database.prepare(
    `SELECT resource_type, resource_name, resource_id FROM installation_resources
      WHERE installation_id = ? AND created_by_later_gator = 1 AND status = 'cleanup_pending'`,
  ).bind(installationId).all<{
    resource_type: InstallationResource["type"];
    resource_name: string;
    resource_id: string;
  }>();
  return rows.results.map((row) => ({
    type: row.resource_type,
    name: row.resource_name,
    id: row.resource_id,
  }));
}

/** Records one confirmed deletion so an interrupted cleanup resumes without repeating work. */
export async function completeResourceCleanup(
  database: D1Database,
  installationId: string,
  type: InstallationResource["type"],
  nowSeconds: number,
): Promise<void> {
  await database.prepare(
    `UPDATE installation_resources SET status = 'deleted', updated_at = ?
      WHERE installation_id = ? AND resource_type = ? AND created_by_later_gator = 1`,
  ).bind(nowSeconds, installationId, type).run();
}

/** Removes the finished installation record only after every owned resource is gone. */
export async function completeInstallationCleanup(
  database: D1Database,
  ownerId: string,
  installationId: string,
): Promise<void> {
  const remaining = await database.prepare(
    `SELECT COUNT(*) AS count FROM installation_resources
      WHERE installation_id = ? AND created_by_later_gator = 1 AND status <> 'deleted'`,
  ).bind(installationId).first<{ count: number }>();
  if ((remaining?.count ?? 0) !== 0) throw new Error("cleanup_resources_remaining");
  await database.batch([
    database.prepare("DELETE FROM installations WHERE id = ? AND owner_id = ?")
      .bind(installationId, ownerId),
    database.prepare("DELETE FROM installer_authorizations WHERE owner_id = ?").bind(ownerId),
  ]);
}
