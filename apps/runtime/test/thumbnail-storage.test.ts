import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThumbnailStore } from "../src/adapters/thumbnail-store";
import {
  approveThumbnailMigrationCleanup,
  disableThumbnailStorage,
  enableKvThumbnailStorage,
  processThumbnailMigration,
  processThumbnailMigrationCleanup,
  startThumbnailMigration,
  thumbnailStorageSummary,
} from "../src/application/thumbnail-storage";
import { sha256Base64 } from "../src/security/encoding";

/** Creates a deterministic in-memory object store for migration fault tests. */
function memoryStore(
  backend: "kv" | "r2",
  objects = new Map<string, Uint8Array<ArrayBuffer>>(),
  failFirstPut = false,
): ThumbnailStore {
  let shouldFail = failFirstPut;
  return {
    backend,
    delete: (key): Promise<void> => {
      objects.delete(key);
      return Promise.resolve();
    },
    get: (key): Promise<ArrayBuffer | null> => {
      const bytes = objects.get(key);
      return Promise.resolve(bytes === undefined ? null : bytes.slice().buffer);
    },
    list: (prefix): Promise<{ cursor: null; keys: string[] }> => Promise.resolve({
      cursor: null,
      keys: [...objects.keys()].filter((key) => key.startsWith(prefix)),
    }),
    put: (key, bytes): Promise<void> => {
      if (shouldFail) {
        shouldFail = false;
        return Promise.reject(new Error("private provider failure"));
      }
      objects.set(key, bytes.slice());
      return Promise.resolve();
    },
  };
}

/** Inserts one isolated bookmark thumbnail and returns its migration fixture. */
async function thumbnailFixture(): Promise<{
  bookmarkId: string;
  bytes: Uint8Array<ArrayBuffer>;
  key: string;
  thumbnailId: string;
}> {
  const bookmarkId = crypto.randomUUID();
  const thumbnailId = crypto.randomUUID();
  const key = `thumbnails/${bookmarkId}/${thumbnailId}.webp`;
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
  const now = new Date().toISOString();
  const contentHash = await sha256Base64(bytes);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO bookmarks (
           id, url, normalized_url, hostname, title, folder_id, source_type,
           organization_policy, ai_state, source_created_at, added_at, modified_at
         ) VALUES (?, ?, ?, 'example.com', 'Migration fixture', 'folder_unsorted',
                   'dashboard', 'none', 'complete', ?, ?, ?)`,
      )
      .bind(
        bookmarkId,
        `https://example.com/${bookmarkId}`,
        `https://example.com/${bookmarkId}`,
        now,
        now,
        now,
      ),
    env.DB
      .prepare(
        `INSERT INTO thumbnails (
           id, bookmark_id, object_key, media_type, width, height, byte_size,
           storage_backend, source_type, etag, state, created_at, updated_at
         ) VALUES (?, ?, ?, 'image/webp', 10, 10, ?, 'kv', 'user', ?, 'ready', ?, ?)`,
      )
      .bind(
        thumbnailId,
        bookmarkId,
        key,
        bytes.byteLength,
        `"sha256-${contentHash}"`,
        now,
        now,
      ),
    env.DB
      .prepare("UPDATE bookmarks SET thumbnail_id = ? WHERE id = ?")
      .bind(thumbnailId, bookmarkId),
  ]);
  return { bookmarkId, bytes, key, thumbnailId };
}

describe("thumbnail resilience and KV-to-R2 migration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("disables and re-enables future thumbnail work without deleting metadata", async () => {
    await disableThumbnailStorage(env.DB);
    expect(await thumbnailStorageSummary(env.DB)).toMatchObject({
      mode: "disabled",
      safeErrorCode: "thumbnail_storage_disabled",
      status: "ready",
    });
    await enableKvThumbnailStorage(env.DB);
    expect(await thumbnailStorageSummary(env.DB)).toMatchObject({
      mode: "kv",
      safeErrorCode: null,
      status: "ready",
    });
  });

  it("copies and verifies before switching reads, then requires cleanup approval", async () => {
    const remoteFetch = vi.fn(() => Promise.reject(new Error("network must remain unused")));
    vi.stubGlobal("fetch", remoteFetch);
    const fixture = await thumbnailFixture();
    const kvObjects = new Map([[fixture.key, fixture.bytes]]);
    const r2Objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const stores = {
      kv: memoryStore("kv", kvObjects),
      r2: memoryStore("r2", r2Objects),
    };
    const migrationId = await startThumbnailMigration(env.DB, stores);

    expect(await processThumbnailMigration(env.DB, stores, migrationId))
      .toBe("awaiting_cleanup");
    expect(await processThumbnailMigration(env.DB, stores, migrationId))
      .toBe("awaiting_cleanup");
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(kvObjects.has(fixture.key)).toBe(true);
    expect(r2Objects.get(fixture.key)).toEqual(fixture.bytes);
    expect(await env.DB.prepare("SELECT storage_backend FROM thumbnails WHERE id = ?")
      .bind(fixture.thumbnailId).first()).toEqual({ storage_backend: "r2" });
    await expect(processThumbnailMigrationCleanup(env.DB, stores, migrationId))
      .rejects.toThrow("thumbnail_cleanup_not_approved");

    expect(await approveThumbnailMigrationCleanup(env.DB, migrationId)).toBe(true);
    expect(await processThumbnailMigrationCleanup(env.DB, stores, migrationId)).toBe("complete");
    expect(kvObjects.has(fixture.key)).toBe(false);
    expect(r2Objects.has(fixture.key)).toBe(true);
  });

  it("retains KV bytes and resumes safely after an interrupted R2 write", async () => {
    await env.DB.prepare(
      `UPDATE app_state
          SET thumbnail_storage_mode = 'kv', thumbnail_storage_status = 'ready',
              thumbnail_storage_safe_error_code = NULL WHERE id = 1`,
    ).run();
    const fixture = await thumbnailFixture();
    const kvObjects = new Map([[fixture.key, fixture.bytes]]);
    const r2Objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const migrationId = await startThumbnailMigration(env.DB, {
      kv: memoryStore("kv", kvObjects),
      r2: memoryStore("r2", r2Objects, true),
    });

    expect(await processThumbnailMigration(env.DB, {
      kv: memoryStore("kv", kvObjects),
      r2: memoryStore("r2", r2Objects, true),
    }, migrationId)).toBe("failed");
    expect(kvObjects.has(fixture.key)).toBe(true);
    expect(await processThumbnailMigration(env.DB, {
      kv: memoryStore("kv", kvObjects),
      r2: memoryStore("r2", r2Objects),
    }, migrationId)).toBe("awaiting_cleanup");
    expect(kvObjects.has(fixture.key)).toBe(true);
  });
});
