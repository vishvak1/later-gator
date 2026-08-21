import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  disabledThumbnailStore,
  kvThumbnailStore,
  readThumbnailStorageState,
  r2ThumbnailStore,
  thumbnailStore,
  ThumbnailStorageFailure,
} from "../src/adapters/thumbnail-store";

describe("runtime-owned thumbnail storage", () => {
  it("reads and lists KV objects through the shared contract", async () => {
    const store = kvThumbnailStore(env.THUMBNAILS);
    const key = `thumbnails/store-test/${crypto.randomUUID()}.webp`;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.put(key, bytes);

    expect(new Uint8Array((await store.get(key)) ?? new ArrayBuffer(0))).toEqual(bytes);
    expect((await store.list("thumbnails/store-test/")).keys).toContain(key);

    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it("keeps disabled mode side-effect free", async () => {
    const store = disabledThumbnailStore();
    expect(await store.get("thumbnails/missing.webp")).toBeNull();
    expect(await store.list("thumbnails/")).toEqual({ cursor: null, keys: [] });
    await expect(store.put("thumbnails/new.webp", new Uint8Array([1])))
      .rejects.toMatchObject({ code: "thumbnail_storage_disabled", retryable: false });
  });

  it("redacts an R2 capacity failure into a stable category", async () => {
    const bucket = {
      delete: (): Promise<void> => Promise.resolve(),
      get: (): Promise<null> => Promise.resolve(null),
      list: (): Promise<R2Objects> => Promise.resolve({
        delimitedPrefixes: [],
        objects: [],
        truncated: false,
      }),
      put: (): Promise<never> => Promise.reject(
        new Error("provider storage full with private request details"),
      ),
    } satisfies Pick<R2Bucket, "delete" | "get" | "list" | "put">;
    const store = r2ThumbnailStore(bucket);

    await expect(store.put("thumbnails/new.webp", new Uint8Array([1])))
      .rejects.toEqual(new ThumbnailStorageFailure("thumbnail_storage_capacity", false));
  });

  it("fails closed when the selected binding is absent", () => {
    expect(() => thumbnailStore("r2", { kv: env.THUMBNAILS })).toThrow(
      "thumbnail_storage_unavailable",
    );
  });

  it("validates storage state read from personal D1", async () => {
    await env.DB.prepare(
      `UPDATE app_state
          SET thumbnail_storage_mode = 'disabled', thumbnail_storage_status = 'ready',
              thumbnail_storage_safe_error_code = 'thumbnail_storage_disabled'
        WHERE id = 1`,
    ).run();
    expect(await readThumbnailStorageState(env.DB)).toEqual({
      mode: "disabled",
      safeErrorCode: "thumbnail_storage_disabled",
      status: "ready",
    });
    await env.DB.prepare(
      `UPDATE app_state
          SET thumbnail_storage_mode = 'kv', thumbnail_storage_status = 'ready',
              thumbnail_storage_safe_error_code = NULL
        WHERE id = 1`,
    ).run();
  });
});
