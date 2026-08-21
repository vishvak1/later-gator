import {
  base64UrlSchema,
  catalogSigningBytes,
  modelCatalogSchema,
  storagePlanCatalogSchema,
  type ModelCatalog,
  type SignedCatalogKind,
  type StoragePlanCatalog,
} from "@later-gator/contracts";
import { z } from "zod";
import { fromBase64Url } from "../security/encoding";

const MAXIMUM_CATALOG_BYTES = 256 * 1024;
const MAXIMUM_JWKS_BYTES = 32 * 1024;
const REFRESH_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;
const MODEL_MAXIMUM_AGE_MILLISECONDS = 180 * 24 * 60 * 60 * 1000;
const PLAN_MAXIMUM_AGE_MILLISECONDS = 366 * 24 * 60 * 60 * 1000;

const publicJwkSchema = z.strictObject({
  alg: z.literal("ES256"),
  crv: z.literal("P-256"),
  kid: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  kty: z.literal("EC"),
  use: z.literal("sig"),
  x: base64UrlSchema,
  y: base64UrlSchema,
});

const publicJwksSchema = z.strictObject({
  keys: z.array(publicJwkSchema).min(1).max(4),
});

type PublicJwks = z.infer<typeof publicJwksSchema>;
type CatalogKind = "models" | "storage-plans";

export type CatalogSafeError =
  | "catalog_invalid"
  | "catalog_network"
  | "catalog_replayed"
  | "catalog_signature_invalid"
  | "catalog_stale";

export class CatalogRefreshFailure extends Error {
  /** Creates a content-free catalog failure suitable for local status storage. */
  constructor(readonly safeCode: CatalogSafeError) {
    super(safeCode);
    this.name = "CatalogRefreshFailure";
  }
}

export interface PublicCatalogState {
  models: ModelCatalog | null;
  storagePlans: StoragePlanCatalog | null;
  status: Record<CatalogKind, { lastCheckedAt: string | null; safeErrorCode: string | null }>;
}

/** Reads one bounded public JSON document without retaining response details. */
async function boundedPublicJson(
  url: URL,
  maximumBytes: number,
  fetcher: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "error" });
  } catch {
    throw new CatalogRefreshFailure("catalog_network");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (
    response.status !== 200 ||
    (Number.isFinite(declared) && declared > maximumBytes)
  ) {
    throw new CatalogRefreshFailure("catalog_network");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new CatalogRefreshFailure("catalog_invalid");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new CatalogRefreshFailure("catalog_invalid");
  }
}

/** Verifies one catalog signature with the rotatable public control-plane keys. */
async function verifyCatalogSignature(
  kind: SignedCatalogKind,
  catalog: { signingKeyId: string; signature: string } & Record<string, unknown>,
  jwks: PublicJwks,
): Promise<void> {
  const jwk = jwks.keys.find((candidate) => candidate.kid === catalog.signingKeyId);
  if (jwk === undefined) throw new CatalogRefreshFailure("catalog_signature_invalid");
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { crv: jwk.crv, ext: true, key_ops: ["verify"], kty: jwk.kty, x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(catalog.signature),
      catalogSigningBytes(kind, catalog),
    );
    if (!valid) throw new CatalogRefreshFailure("catalog_signature_invalid");
  } catch (error: unknown) {
    if (error instanceof CatalogRefreshFailure) throw error;
    throw new CatalogRefreshFailure("catalog_signature_invalid");
  }
}

/** Rejects future or old publication timestamps while retaining a prior cache. */
function assertFreshTimestamp(value: string, maximumAge: number, now: Date): void {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now.getTime() + 5 * 60 * 1000 ||
    now.getTime() - timestamp > maximumAge
  ) {
    throw new CatalogRefreshFailure("catalog_stale");
  }
}

/** Stores a newer signed catalog revision without touching provider settings. */
async function acceptCatalog(
  database: D1Database,
  kind: CatalogKind,
  revision: number,
  sourceTimestamp: string,
  catalog: ModelCatalog | StoragePlanCatalog,
  now: Date,
): Promise<void> {
  const existing = await database
    .prepare("SELECT revision FROM public_catalog_cache WHERE kind = ?")
    .bind(kind)
    .first<{ revision: number }>();
  if (existing !== null && revision < existing.revision) {
    throw new CatalogRefreshFailure("catalog_replayed");
  }
  const acceptedAt = now.toISOString();
  await database.batch([
    database
      .prepare(
        `INSERT INTO public_catalog_cache (
           kind, revision, payload_json, source_timestamp, accepted_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET
           revision = excluded.revision,
           payload_json = excluded.payload_json,
           source_timestamp = excluded.source_timestamp,
           accepted_at = excluded.accepted_at
         WHERE excluded.revision >= public_catalog_cache.revision`,
      )
      .bind(kind, revision, JSON.stringify(catalog), sourceTimestamp, acceptedAt),
    database
      .prepare(
        `UPDATE public_catalog_status
            SET last_checked_at = ?, last_safe_error_code = NULL, updated_at = ?
          WHERE kind = ?`,
      )
      .bind(acceptedAt, acceptedAt, kind),
  ]);
}

/** Records only a bounded catalog failure code in the personal runtime. */
async function recordCatalogFailure(
  database: D1Database,
  kind: CatalogKind,
  failure: CatalogRefreshFailure,
  now: Date,
): Promise<void> {
  await database
    .prepare(
      `UPDATE public_catalog_status
          SET last_checked_at = ?, last_safe_error_code = ?, updated_at = ?
        WHERE kind = ?`,
    )
    .bind(now.toISOString(), failure.safeCode, now.toISOString(), kind)
    .run();
}

/** Fetches, validates, verifies, and caches both public catalogs independently. */
export async function refreshPublicCatalogs(
  database: D1Database,
  controlPlaneOrigin: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  const jwksInput = await boundedPublicJson(
    new URL("/.well-known/later-gator-jwks.json", controlPlaneOrigin),
    MAXIMUM_JWKS_BYTES,
    fetcher,
  );
  const jwks = publicJwksSchema.safeParse(jwksInput);
  if (!jwks.success) throw new CatalogRefreshFailure("catalog_invalid");

  for (const kind of ["models", "storage-plans"] as const) {
    try {
      const input = await boundedPublicJson(
        new URL(`/catalogs/${kind}`, controlPlaneOrigin),
        MAXIMUM_CATALOG_BYTES,
        fetcher,
      );
      if (kind === "models") {
        const parsed = modelCatalogSchema.safeParse(input);
        if (!parsed.success) throw new CatalogRefreshFailure("catalog_invalid");
        assertFreshTimestamp(parsed.data.publishedAt, MODEL_MAXIMUM_AGE_MILLISECONDS, now);
        await verifyCatalogSignature("model-catalog", parsed.data, jwks.data);
        await acceptCatalog(
          database,
          kind,
          parsed.data.revision,
          parsed.data.publishedAt,
          parsed.data,
          now,
        );
      } else {
        const parsed = storagePlanCatalogSchema.safeParse(input);
        if (!parsed.success) throw new CatalogRefreshFailure("catalog_invalid");
        assertFreshTimestamp(
          `${parsed.data.reviewedOn}T00:00:00.000Z`,
          PLAN_MAXIMUM_AGE_MILLISECONDS,
          now,
        );
        await verifyCatalogSignature("storage-plan-catalog", parsed.data, jwks.data);
        await acceptCatalog(
          database,
          kind,
          parsed.data.revision,
          parsed.data.reviewedOn,
          parsed.data,
          now,
        );
      }
    } catch (error: unknown) {
      const failure = error instanceof CatalogRefreshFailure
        ? error
        : new CatalogRefreshFailure("catalog_invalid");
      await recordCatalogFailure(database, kind, failure, now);
    }
  }
}

/** Reads and revalidates only the last signed catalogs accepted into personal D1. */
export async function readPublicCatalogState(database: D1Database): Promise<PublicCatalogState> {
  const cached = await database
    .prepare("SELECT kind, payload_json FROM public_catalog_cache")
    .all<{ kind: CatalogKind; payload_json: string }>();
  let models: ModelCatalog | null = null;
  let storagePlans: StoragePlanCatalog | null = null;
  for (const row of cached.results) {
    try {
      const input = JSON.parse(row.payload_json) as unknown;
      if (row.kind === "models") {
        const parsed = modelCatalogSchema.safeParse(input);
        if (parsed.success) models = parsed.data;
      } else {
        const parsed = storagePlanCatalogSchema.safeParse(input);
        if (parsed.success) storagePlans = parsed.data;
      }
    } catch {
      // A malformed cache is ignored and can be repaired by the next refresh.
    }
  }
  const statusRows = await database
    .prepare("SELECT kind, last_checked_at, last_safe_error_code FROM public_catalog_status")
    .all<{ kind: CatalogKind; last_checked_at: string | null; last_safe_error_code: string | null }>();
  const status: PublicCatalogState["status"] = {
    models: { lastCheckedAt: null, safeErrorCode: null },
    "storage-plans": { lastCheckedAt: null, safeErrorCode: null },
  };
  for (const row of statusRows.results) {
    status[row.kind] = {
      lastCheckedAt: row.last_checked_at,
      safeErrorCode: row.last_safe_error_code,
    };
  }
  return { models, storagePlans, status };
}

/** Refreshes at most daily and always falls back to the last valid local copy. */
export async function currentPublicCatalogState(
  database: D1Database,
  controlPlaneOrigin: string,
): Promise<PublicCatalogState> {
  const state = await readPublicCatalogState(database);
  const lastChecked = Math.min(
    ...Object.values(state.status).map((entry) =>
      entry.lastCheckedAt === null ? 0 : Date.parse(entry.lastCheckedAt)),
  );
  if (!Number.isFinite(lastChecked) || Date.now() - lastChecked >= REFRESH_INTERVAL_MILLISECONDS) {
    try {
      await refreshPublicCatalogs(database, controlPlaneOrigin);
    } catch (error: unknown) {
      const failure = error instanceof CatalogRefreshFailure
        ? error
        : new CatalogRefreshFailure("catalog_network");
      const now = new Date();
      await Promise.all([
        recordCatalogFailure(database, "models", failure, now),
        recordCatalogFailure(database, "storage-plans", failure, now),
      ]);
    }
  }
  return readPublicCatalogState(database);
}
