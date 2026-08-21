import { z } from "zod";
import { randomBytes, sha256Base64, toBase64 } from "./encoding";

export type CaptureKind = "extension" | "ios";

interface CaptureCredentialRow {
  id: string;
  scopes: string;
}

/** Issues a random, hashed, narrowly scoped capture credential. */
export async function issueCaptureCredential(
  db: D1Database,
  kind: CaptureKind,
  name: string,
): Promise<{ id: string; token: string; scopes: string[] }> {
  const id = crypto.randomUUID();
  const token = toBase64(randomBytes(32)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const scopes =
    kind === "ios"
      ? ["capture:create:minimal"]
      : [
          "capture:options",
          "capture:create",
          "capture:result:self",
          "capture:bookmark-search",
        ];
  await db
    .prepare(
      `INSERT INTO capture_credentials (
        id, name, token_hash, scopes, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, name.slice(0, 100), await sha256Base64(token), JSON.stringify(scopes), new Date().toISOString())
    .run();
  return { id, token, scopes };
}

/** Atomically consumes a signed pairing grant and issues one extension credential. */
export async function issuePairedExtensionCredential(
  db: D1Database,
  input: { deviceId: string; deviceName: string; jtiHash: string },
): Promise<{ id: string; token: string; scopes: string[] }> {
  const id = crypto.randomUUID();
  const token = toBase64(randomBytes(32)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const scopes = [
    "capture:options",
    "capture:create",
    "capture:result:self",
    "capture:bookmark-search",
  ];
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO extension_pairing_jtis (jti_hash, consumed_at)
         VALUES (?, ?) ON CONFLICT(jti_hash) DO NOTHING`,
      )
      .bind(input.jtiHash, now),
    db
      .prepare(
        `INSERT INTO capture_credentials (id, name, token_hash, scopes, created_at)
         SELECT ?, ?, ?, ?, ?
          WHERE changes() = 1`,
      )
      .bind(
        id,
        input.deviceName.slice(0, 100),
        await sha256Base64(token),
        JSON.stringify(scopes),
        now,
      ),
    db
      .prepare(
        `INSERT INTO extension_devices (
           id, credential_id, name, connected_at
         ) SELECT ?, ?, ?, ? WHERE changes() = 1
         ON CONFLICT(id) DO UPDATE SET
           credential_id = excluded.credential_id,
           name = excluded.name,
           connected_at = excluded.connected_at,
           last_used_at = NULL,
           revoked_at = NULL
         WHERE extension_devices.revoked_at IS NOT NULL`,
      )
      .bind(input.deviceId, id, input.deviceName.slice(0, 100), now),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    throw new Error("pairing_grant_replayed");
  }
  return { id, token, scopes };
}

export interface ExtensionDeviceSummary {
  id: string;
  name: string;
  connectedAt: string;
  lastUsedAt: string | null;
}

/** Lists only safe extension-device metadata for the owner settings page. */
export async function listExtensionDevices(db: D1Database): Promise<ExtensionDeviceSummary[]> {
  const rows = await db
    .prepare(
      `SELECT id, name, connected_at, last_used_at
         FROM extension_devices WHERE revoked_at IS NULL
        ORDER BY connected_at DESC`,
    )
    .all<{ id: string; name: string; connected_at: string; last_used_at: string | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Revokes one extension device and its underlying narrow capture credential. */
export async function revokeExtensionDevice(db: D1Database, deviceId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const device = await db
    .prepare("SELECT credential_id FROM extension_devices WHERE id = ? AND revoked_at IS NULL")
    .bind(deviceId)
    .first<{ credential_id: string }>();
  if (device === null) return false;
  const results = await db.batch([
    db
      .prepare("UPDATE extension_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, deviceId),
    db
      .prepare("UPDATE capture_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, device.credential_id),
  ]);
  return results[0]?.meta.changes === 1;
}

/** Verifies a scoped capture bearer token and refreshes its last-used time. */
export async function authenticateCapture(
  request: Request,
  db: D1Database,
  requiredScope: string,
): Promise<{ id: string; scopes: string[] } | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  if (token.length < 32 || token.length > 256) return null;
  const row = await db
    .prepare(
      `SELECT id, scopes
         FROM capture_credentials
        WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await sha256Base64(token))
    .first<CaptureCredentialRow>();
  if (row === null) return null;
  const parsed = z.array(z.string()).safeParse(JSON.parse(row.scopes) as unknown);
  if (!parsed.success || !parsed.data.includes(requiredScope)) return null;
  const usedAt = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE capture_credentials SET last_used_at = ? WHERE id = ?").bind(usedAt, row.id),
    db.prepare("UPDATE extension_devices SET last_used_at = ? WHERE credential_id = ?").bind(usedAt, row.id),
  ]);
  return { id: row.id, scopes: parsed.data };
}

/** Revokes the active capture credential without exposing its token. */
export async function revokeCaptureCredential(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE capture_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), id)
    .run();
  return result.meta.changes === 1;
}
