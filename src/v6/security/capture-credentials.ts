import { z } from "zod";
import { randomBytes, sha256Base64, toBase64 } from "./encoding";

export type CaptureKind = "extension" | "ios";

interface CaptureCredentialRow {
  id: string;
  scopes: string;
}

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
  await db
    .prepare("UPDATE capture_credentials SET last_used_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  return { id: row.id, scopes: parsed.data };
}

export async function revokeCaptureCredential(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE capture_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), id)
    .run();
  return result.meta.changes === 1;
}
