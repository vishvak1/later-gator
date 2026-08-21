import type {
  ThumbnailStorageMode,
  ThumbnailStore,
  ThumbnailStoreBindings,
} from "../adapters/thumbnail-store";
import {
  runtimeThumbnailBindings,
  thumbnailStore,
  ThumbnailStorageFailure,
} from "../adapters/thumbnail-store";
import { sha256Base64 } from "../security/encoding";

const MIGRATION_BATCH_SIZE = 25;

export interface ThumbnailStorageSummary {
  byteSize: number;
  migrationId: string | null;
  migrationState: string | null;
  mode: ThumbnailStorageMode;
  objectCount: number;
  safeErrorCode: string | null;
  status: "ready" | "paused" | "migrating";
}

export interface ThumbnailMigrationStores {
  kv: ThumbnailStore;
  r2: ThumbnailStore;
}

/** Creates the KV/R2 pair only after both personal bindings are present. */
export function runtimeThumbnailMigrationStores(env: Env): ThumbnailMigrationStores {
  const bindings = runtimeThumbnailBindings(env);
  return {
    kv: thumbnailStore("kv", bindings),
    r2: thumbnailStore("r2", bindings),
  };
}

/** Returns content-free storage status for the owner settings page. */
export async function thumbnailStorageSummary(
  database: D1Database,
): Promise<ThumbnailStorageSummary> {
  const row = await database
    .prepare(
      `SELECT a.thumbnail_storage_mode, a.thumbnail_storage_status,
              a.thumbnail_storage_safe_error_code,
              COUNT(t.id) AS object_count, COALESCE(SUM(t.byte_size), 0) AS byte_size,
              (SELECT id FROM thumbnail_migrations
                WHERE state != 'complete' AND state != 'cancelled'
                ORDER BY created_at DESC LIMIT 1) AS migration_id,
              (SELECT state FROM thumbnail_migrations
                WHERE state != 'complete' AND state != 'cancelled'
                ORDER BY created_at DESC LIMIT 1) AS migration_state
         FROM app_state a LEFT JOIN thumbnails t ON t.state = 'ready'
        WHERE a.id = 1 GROUP BY a.id`,
    )
    .first<{
      thumbnail_storage_mode: ThumbnailStorageMode;
      thumbnail_storage_status: "ready" | "paused" | "migrating";
      thumbnail_storage_safe_error_code: string | null;
      migration_id: string | null;
      object_count: number;
      byte_size: number;
      migration_state: string | null;
    }>();
  if (row === null) throw new Error("thumbnail_storage_state_unavailable");
  return {
    byteSize: row.byte_size,
    migrationId: row.migration_id,
    migrationState: row.migration_state,
    mode: row.thumbnail_storage_mode,
    objectCount: row.object_count,
    safeErrorCode: row.thumbnail_storage_safe_error_code,
    status: row.thumbnail_storage_status,
  };
}

/** Disables future thumbnail work without deleting existing thumbnail bytes. */
export async function disableThumbnailStorage(database: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE app_state
            SET thumbnail_storage_mode = 'disabled', thumbnail_storage_status = 'ready',
                thumbnail_storage_safe_error_code = 'thumbnail_storage_disabled',
                updated_at = ? WHERE id = 1`,
      )
      .bind(now),
    database
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'cancelled', last_safe_error_code = 'thumbnail_storage_disabled',
                completed_at = ?, updated_at = ?
          WHERE state IN ('pending_dispatch', 'queued', 'running', 'paused_storage')`,
      )
      .bind(now, now),
  ]);
}

/** Resumes KV thumbnail work after an owner explicitly re-enables it. */
export async function enableKvThumbnailStorage(database: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE app_state
            SET thumbnail_storage_mode = 'kv', thumbnail_storage_status = 'ready',
                thumbnail_storage_safe_error_code = NULL, updated_at = ?
          WHERE id = 1 AND thumbnail_storage_status != 'migrating'`,
      )
      .bind(now),
    database
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'pending_dispatch', last_safe_error_code = NULL,
                completed_at = NULL, next_attempt_at = NULL, updated_at = ?
          WHERE state = 'paused_storage'`,
      )
      .bind(now),
  ]);
}

/** Reclaims oldest thumbnail objects without deleting their bookmarks. */
export async function reclaimOldThumbnails(
  database: D1Database,
  bindings: ThumbnailStoreBindings,
  limit: number,
): Promise<{ byteSize: number; objectCount: number }> {
  const rows = await database
    .prepare(
      `SELECT id, bookmark_id, object_key, byte_size, storage_backend
         FROM thumbnails WHERE state = 'ready'
        ORDER BY created_at, id LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string;
      bookmark_id: string;
      object_key: string;
      byte_size: number;
      storage_backend: "kv" | "r2";
    }>();
  let byteSize = 0;
  let objectCount = 0;
  for (const row of rows.results) {
    await thumbnailStore(row.storage_backend, bindings).delete(row.object_key);
    await database.batch([
      database
        .prepare("UPDATE bookmarks SET thumbnail_id = NULL WHERE id = ? AND thumbnail_id = ?")
        .bind(row.bookmark_id, row.id),
      database.prepare("DELETE FROM thumbnails WHERE id = ?").bind(row.id),
    ]);
    byteSize += row.byte_size;
    objectCount += 1;
  }
  return { byteSize, objectCount };
}

/** Creates an immutable object checklist for a resumable KV-to-R2 migration. */
export async function startThumbnailMigration(
  database: D1Database,
  stores: ThumbnailMigrationStores,
): Promise<string> {
  if (stores.kv.backend !== "kv" || stores.r2.backend !== "r2") {
    throw new ThumbnailStorageFailure("thumbnail_storage_unavailable", true);
  }
  const existing = await database
    .prepare(
      `SELECT id FROM thumbnail_migrations
        WHERE state IN ('copying', 'awaiting_cleanup', 'cleaning', 'failed')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .first<{ id: string }>();
  if (existing !== null) return existing.id;
  const state = await database
    .prepare("SELECT thumbnail_storage_mode FROM app_state WHERE id = 1")
    .first<{ thumbnail_storage_mode: string }>();
  if (state?.thumbnail_storage_mode !== "kv") {
    throw new Error("thumbnail_migration_source_invalid");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `INSERT INTO thumbnail_migrations (
           id, source_backend, target_backend, state, created_at, updated_at
         ) VALUES (?, 'kv', 'r2', 'copying', ?, ?)`,
      )
      .bind(id, now, now),
    database
      .prepare(
        `INSERT INTO thumbnail_migration_objects (
           migration_id, thumbnail_id, object_key, byte_size, content_hash, state, updated_at
         )
         SELECT ?, id, object_key, byte_size,
                COALESCE(REPLACE(REPLACE(etag, '"sha256-', ''), '"', ''), ''),
                'pending', ?
           FROM thumbnails WHERE storage_backend = 'kv' AND state = 'ready'`,
      )
      .bind(id, now),
    database
      .prepare(
        `UPDATE app_state
            SET thumbnail_storage_status = 'migrating',
                thumbnail_storage_safe_error_code = NULL, updated_at = ?
          WHERE id = 1`,
      )
      .bind(now),
  ]);
  return id;
}

/** Records a bounded migration failure while retaining every source object. */
async function failThumbnailMigration(
  database: D1Database,
  migrationId: string,
  thumbnailId: string,
  safeErrorCode: string,
): Promise<void> {
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE thumbnail_migrations
            SET state = 'failed', safe_error_code = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(safeErrorCode, now, migrationId),
    database
      .prepare(
        `UPDATE thumbnail_migration_objects
            SET state = 'failed', safe_error_code = ?, updated_at = ?
          WHERE migration_id = ? AND thumbnail_id = ?`,
      )
      .bind(safeErrorCode, now, migrationId, thumbnailId),
  ]);
}

/** Copies and verifies one bounded batch without deleting any KV source bytes. */
export async function processThumbnailMigration(
  database: D1Database,
  stores: ThumbnailMigrationStores,
  migrationId: string,
): Promise<"continued" | "awaiting_cleanup" | "failed"> {
  await database
    .prepare(
      `UPDATE thumbnail_migrations
          SET state = 'copying', safe_error_code = NULL, updated_at = ?
        WHERE id = ? AND state IN ('copying', 'failed')`,
    )
    .bind(new Date().toISOString(), migrationId)
    .run();
  const rows = await database
    .prepare(
      `SELECT thumbnail_id, object_key, byte_size, content_hash
         FROM thumbnail_migration_objects
        WHERE migration_id = ? AND state IN ('pending', 'failed')
        ORDER BY thumbnail_id LIMIT ?`,
    )
    .bind(migrationId, MIGRATION_BATCH_SIZE)
    .all<{
      thumbnail_id: string;
      object_key: string;
      byte_size: number;
      content_hash: string;
    }>();
  for (const row of rows.results) {
    try {
      const source = await stores.kv.get(row.object_key);
      if (source?.byteLength !== row.byte_size) {
        await failThumbnailMigration(
          database,
          migrationId,
          row.thumbnail_id,
          "thumbnail_migration_source_missing",
        );
        return "failed";
      }
      const sourceBytes = new Uint8Array(source);
      const sourceHash = await sha256Base64(sourceBytes);
      if (row.content_hash !== "" && sourceHash !== row.content_hash) {
        await failThumbnailMigration(
          database,
          migrationId,
          row.thumbnail_id,
          "thumbnail_migration_source_mismatch",
        );
        return "failed";
      }
      await stores.r2.put(row.object_key, sourceBytes);
      const target = await stores.r2.get(row.object_key);
      if (
        target?.byteLength !== source.byteLength ||
        await sha256Base64(new Uint8Array(target)) !== sourceHash
      ) {
        await failThumbnailMigration(
          database,
          migrationId,
          row.thumbnail_id,
          "thumbnail_migration_verification_failed",
        );
        return "failed";
      }
      const now = new Date().toISOString();
      await database.batch([
        database
          .prepare(
            `UPDATE thumbnail_migration_objects
                SET state = 'verified', content_hash = ?, safe_error_code = NULL,
                    updated_at = ?
              WHERE migration_id = ? AND thumbnail_id = ?`,
          )
          .bind(sourceHash, now, migrationId, row.thumbnail_id),
        database
          .prepare(
            `UPDATE thumbnails SET storage_backend = 'r2', updated_at = ?
              WHERE id = ? AND storage_backend = 'kv'`,
          )
          .bind(now, row.thumbnail_id),
        database
          .prepare(
            `UPDATE thumbnail_migrations
                SET copied_count = copied_count + 1,
                    verified_count = verified_count + 1, updated_at = ?
              WHERE id = ?`,
          )
          .bind(now, migrationId),
      ]);
    } catch (error: unknown) {
      const safeErrorCode = error instanceof ThumbnailStorageFailure
        ? error.code
        : "thumbnail_storage_unavailable";
      await failThumbnailMigration(database, migrationId, row.thumbnail_id, safeErrorCode);
      return "failed";
    }
  }
  const remaining = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM thumbnail_migration_objects
        WHERE migration_id = ? AND state IN ('pending', 'failed')`,
    )
    .bind(migrationId)
    .first<{ count: number }>();
  if ((remaining?.count ?? 0) > 0) return "continued";
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE thumbnail_migrations
            SET state = 'awaiting_cleanup', safe_error_code = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .bind(now, migrationId),
    database
      .prepare(
        `UPDATE app_state
            SET thumbnail_storage_mode = 'r2', thumbnail_storage_status = 'ready',
                thumbnail_storage_safe_error_code = NULL, updated_at = ?
          WHERE id = 1`,
      )
      .bind(now),
  ]);
  return "awaiting_cleanup";
}

/** Records explicit owner approval before any verified KV source is deleted. */
export async function approveThumbnailMigrationCleanup(
  database: D1Database,
  migrationId: string,
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE thumbnail_migrations SET state = 'cleaning', updated_at = ?
        WHERE id = ? AND state = 'awaiting_cleanup'`,
    )
    .bind(new Date().toISOString(), migrationId)
    .run();
  return result.meta.changes === 1;
}

/** Deletes only already-verified KV sources after approval and supports retries. */
export async function processThumbnailMigrationCleanup(
  database: D1Database,
  stores: ThumbnailMigrationStores,
  migrationId: string,
): Promise<"continued" | "complete"> {
  const migration = await database
    .prepare("SELECT state FROM thumbnail_migrations WHERE id = ?")
    .bind(migrationId)
    .first<{ state: string }>();
  if (migration?.state !== "cleaning") throw new Error("thumbnail_cleanup_not_approved");
  const rows = await database
    .prepare(
      `SELECT thumbnail_id, object_key FROM thumbnail_migration_objects
        WHERE migration_id = ? AND state = 'verified'
        ORDER BY thumbnail_id LIMIT ?`,
    )
    .bind(migrationId, MIGRATION_BATCH_SIZE)
    .all<{ thumbnail_id: string; object_key: string }>();
  for (const row of rows.results) {
    await stores.kv.delete(row.object_key);
    await database.batch([
      database
        .prepare(
          `UPDATE thumbnail_migration_objects SET state = 'deleted', updated_at = ?
            WHERE migration_id = ? AND thumbnail_id = ? AND state = 'verified'`,
        )
        .bind(new Date().toISOString(), migrationId, row.thumbnail_id),
      database
        .prepare(
          `UPDATE thumbnail_migrations
              SET deleted_count = deleted_count + 1, updated_at = ? WHERE id = ?`,
        )
        .bind(new Date().toISOString(), migrationId),
    ]);
  }
  const remaining = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM thumbnail_migration_objects
        WHERE migration_id = ? AND state = 'verified'`,
    )
    .bind(migrationId)
    .first<{ count: number }>();
  if ((remaining?.count ?? 0) > 0) return "continued";
  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE thumbnail_migrations
          SET state = 'complete', completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'cleaning'`,
    )
    .bind(now, now, migrationId)
    .run();
  return "complete";
}

/** Builds stores from already-validated provisioned bindings. */
export function thumbnailMigrationStores(
  bindings: ThumbnailStoreBindings,
): ThumbnailMigrationStores {
  return {
    kv: thumbnailStore("kv", bindings),
    r2: thumbnailStore("r2", bindings),
  };
}
