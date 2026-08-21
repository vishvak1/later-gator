import { z } from "zod";

export type ThumbnailStorageBackend = "kv" | "r2";
export type ThumbnailStorageMode = ThumbnailStorageBackend | "disabled";
export type ThumbnailStorageSafeError =
  | "thumbnail_storage_capacity"
  | "thumbnail_storage_disabled"
  | "thumbnail_storage_quota"
  | "thumbnail_storage_unavailable";

export interface ThumbnailObjectPage {
  cursor: string | null;
  keys: string[];
}

/** Minimal object-storage contract shared by KV, R2, and disabled mode. */
export interface ThumbnailStore {
  readonly backend: ThumbnailStorageMode;
  delete(key: string): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  list(prefix: string, cursor?: string): Promise<ThumbnailObjectPage>;
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** Safe storage failure whose code may be persisted without provider details. */
export class ThumbnailStorageFailure extends Error {
  constructor(
    readonly code: ThumbnailStorageSafeError,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ThumbnailStorageFailure";
  }
}

/** Maps provider-specific storage errors into bounded owner-visible categories. */
function storageFailure(error: unknown): ThumbnailStorageFailure {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const summary = `${name} ${message}`.toLocaleLowerCase("en-US");
  if (/quota|rate.?limit|too many|429/u.test(summary)) {
    return new ThumbnailStorageFailure("thumbnail_storage_quota", true);
  }
  if (/capacity|storage.?limit|full|too large|413/u.test(summary)) {
    return new ThumbnailStorageFailure("thumbnail_storage_capacity", false);
  }
  return new ThumbnailStorageFailure("thumbnail_storage_unavailable", true);
}

/** Runs one storage operation while preventing raw provider errors from escaping. */
async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof ThumbnailStorageFailure) throw error;
    throw storageFailure(error);
  }
}

/** Wraps a Workers KV namespace behind the runtime-owned thumbnail contract. */
export function kvThumbnailStore(namespace: KVNamespace): ThumbnailStore {
  return {
    backend: "kv",
    delete: async (key): Promise<void> => {
      await safely(async () => {
        await namespace.delete(key);
      });
    },
    get: async (key): Promise<ArrayBuffer | null> =>
      await safely(async () => await namespace.get(key, "arrayBuffer")),
    list: async (prefix, cursor): Promise<ThumbnailObjectPage> => await safely(async () => {
      const page = await namespace.list({ prefix, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      return {
        keys: page.keys.map((key) => key.name),
        cursor: page.list_complete ? null : page.cursor,
      };
    }),
    put: async (key, bytes): Promise<void> => {
      await safely(async () => {
        await namespace.put(key, bytes);
      });
    },
  };
}

type R2ThumbnailBucket = Pick<R2Bucket, "delete" | "get" | "list" | "put">;

/** Wraps an R2 bucket behind the runtime-owned thumbnail contract. */
export function r2ThumbnailStore(bucket: R2ThumbnailBucket): ThumbnailStore {
  return {
    backend: "r2",
    delete: async (key): Promise<void> => {
      await safely(async () => {
        await bucket.delete(key);
      });
    },
    get: async (key): Promise<ArrayBuffer | null> => await safely(async () => {
      const object = await bucket.get(key);
      return object === null ? null : await object.arrayBuffer();
    }),
    list: async (prefix, cursor): Promise<ThumbnailObjectPage> => await safely(async () => {
      const page = await bucket.list({ prefix, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      return {
        keys: page.objects.map((object) => object.key),
        cursor: page.truncated ? page.cursor : null,
      };
    }),
    put: async (key, bytes): Promise<void> => {
      await safely(async () => {
        await bucket.put(key, bytes, { httpMetadata: { contentType: "image/webp" } });
      });
    },
  };
}

/** Implements the intentional no-thumbnail mode without touching Cloudflare storage. */
export function disabledThumbnailStore(): ThumbnailStore {
  return {
    backend: "disabled",
    delete: (): Promise<void> => Promise.resolve(),
    get: (): Promise<null> => Promise.resolve(null),
    list: (): Promise<ThumbnailObjectPage> => Promise.resolve({ cursor: null, keys: [] }),
    put: (): Promise<void> => Promise.reject(
      new ThumbnailStorageFailure("thumbnail_storage_disabled", false),
    ),
  };
}

export interface ThumbnailStoreBindings {
  kv?: KVNamespace;
  r2?: R2ThumbnailBucket;
}

/** Discovers only thumbnail bindings present in the provisioned runtime variant. */
export function runtimeThumbnailBindings(
  env: Env | R2ThumbnailBindingEnv,
): ThumbnailStoreBindings {
  return {
    ...( "THUMBNAILS" in env ? { kv: env.THUMBNAILS } : {}),
    ...( "THUMBNAILS_R2" in env ? { r2: env.THUMBNAILS_R2 } : {}),
  };
}

const thumbnailStorageStateSchema = z.object({
  thumbnail_storage_mode: z.enum(["kv", "r2", "disabled"]),
  thumbnail_storage_status: z.enum(["ready", "paused", "migrating"]),
  thumbnail_storage_safe_error_code: z.enum([
    "thumbnail_storage_capacity",
    "thumbnail_storage_disabled",
    "thumbnail_storage_quota",
    "thumbnail_storage_unavailable",
  ]).nullable(),
}).strict();

/** Resolves only the configured backend and fails closed when its binding is absent. */
export function thumbnailStore(
  mode: ThumbnailStorageMode,
  bindings: ThumbnailStoreBindings,
): ThumbnailStore {
  if (mode === "disabled") return disabledThumbnailStore();
  if (mode === "kv" && bindings.kv !== undefined) return kvThumbnailStore(bindings.kv);
  if (mode === "r2" && bindings.r2 !== undefined) return r2ThumbnailStore(bindings.r2);
  throw new ThumbnailStorageFailure("thumbnail_storage_unavailable", true);
}

/** Reads the personal installation's current storage mode and safe storage state. */
export async function readThumbnailStorageState(database: D1Database): Promise<{
  mode: ThumbnailStorageMode;
  status: "ready" | "paused" | "migrating";
  safeErrorCode: ThumbnailStorageSafeError | null;
}> {
  const row = await database
    .prepare(
      `SELECT thumbnail_storage_mode, thumbnail_storage_status,
              thumbnail_storage_safe_error_code
         FROM app_state WHERE id = 1`,
    )
    .first<{
      thumbnail_storage_mode: string;
      thumbnail_storage_status: string;
      thumbnail_storage_safe_error_code: string | null;
    }>();
  const parsed = thumbnailStorageStateSchema.safeParse(row);
  if (!parsed.success) {
    throw new ThumbnailStorageFailure("thumbnail_storage_unavailable", true);
  }
  return {
    mode: parsed.data.thumbnail_storage_mode,
    status: parsed.data.thumbnail_storage_status,
    safeErrorCode: parsed.data.thumbnail_storage_safe_error_code,
  };
}

/** Persists only a bounded storage category and pauses thumbnail work alone. */
export async function pauseThumbnailStorage(
  database: D1Database,
  failure: ThumbnailStorageFailure,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE app_state
            SET thumbnail_storage_status = 'paused',
                thumbnail_storage_safe_error_code = ?, updated_at = ?
          WHERE id = 1`,
      )
      .bind(failure.code, new Date().toISOString()),
    database
      .prepare(
        `UPDATE thumbnail_jobs
            SET state = 'paused_storage', last_safe_error_code = ?, updated_at = ?
          WHERE state IN ('pending_dispatch', 'queued', 'running')`,
      )
      .bind(failure.code, new Date().toISOString()),
  ]);
}
