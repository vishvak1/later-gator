import {
  fromBase64,
  randomBytes,
  sha256Base64,
  toBase64,
  utf8,
} from "./encoding";
import { decryptWithRawKey, encryptWithRawKey } from "./password-vault";

const SESSION_COOKIE = "lg_session";
const IDLE_MILLISECONDS = 24 * 60 * 60 * 1000;
const ABSOLUTE_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;

interface SessionRow {
  id_hash: string;
  encrypted_data_key: string;
  data_key_nonce: string;
  csrf_token_hash: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
}

export interface DashboardSession {
  idHash: string;
  token: string;
  rawDataKey: Uint8Array<ArrayBuffer>;
}

/** Extracts a named cookie value from an incoming request. */
export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

/** Derives the AES key used to wrap a session's copy of the data key. */
async function sessionEncryptionKey(token: string): Promise<Uint8Array<ArrayBuffer>> {
  return fromBase64(await sha256Base64(`session-key:${token}`));
}

/** Persists a hashed session token and returns the browser cookie value. */
export async function createSession(
  db: D1Database,
  rawDataKey: Uint8Array<ArrayBuffer>,
): Promise<{ cookie: string; csrfToken: string }> {
  const token = toBase64(randomBytes(32));
  const csrfToken = toBase64(randomBytes(32));
  const idHash = await sha256Base64(token);
  const csrfTokenHash = await sha256Base64(csrfToken);
  const encrypted = await encryptWithRawKey(await sessionEncryptionKey(token), rawDataKey);
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + IDLE_MILLISECONDS).toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_MILLISECONDS).toISOString();

  await db
    .prepare(
      `INSERT INTO sessions (
        id_hash, encrypted_data_key, data_key_nonce, csrf_token_hash, created_at,
        last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      idHash,
      encrypted.ciphertext,
      encrypted.nonce,
      csrfTokenHash,
      now.toISOString(),
      now.toISOString(),
      idleExpiresAt,
      absoluteExpiresAt,
    )
    .run();

  return {
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${(
      ABSOLUTE_MILLISECONDS / 1000
    ).toString()}`,
    csrfToken,
  };
}

/** Validates the session cookie, expiry, and CSRF state for a request. */
export async function loadSession(
  request: Request,
  db: D1Database,
): Promise<DashboardSession | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null || token.length > 256) return null;
  const idHash = await sha256Base64(token);
  const row = await db
    .prepare(
      `SELECT id_hash, encrypted_data_key, data_key_nonce, csrf_token_hash,
              idle_expires_at, absolute_expires_at, revoked_at
         FROM sessions
        WHERE id_hash = ?`,
    )
    .bind(idHash)
    .first<SessionRow>();

  const now = Date.now();
  if (row === null) return null;
  if (
    row.revoked_at !== null ||
    Date.parse(row.idle_expires_at) <= now ||
    Date.parse(row.absolute_expires_at) <= now
  ) {
    return null;
  }

  try {
    const rawDataKey = await decryptWithRawKey(
      await sessionEncryptionKey(token),
      row.encrypted_data_key,
      row.data_key_nonce,
    );
    return { idHash: row.id_hash, token, rawDataKey };
  } catch {
    return null;
  }
}

/** Validates the submitted CSRF token against the authenticated session hash. */
export async function requireCsrf(
  request: Request,
  db: D1Database,
  session: DashboardSession,
): Promise<boolean> {
  const supplied = request.headers.get("x-csrf-token");
  if (supplied === null || supplied.length > 256) return false;
  const suppliedHash = await sha256Base64(supplied);
  const result = await db
    .prepare(
      `SELECT 1
         FROM sessions
        WHERE id_hash = ? AND csrf_token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(session.idHash, suppliedHash)
    .first<{ 1: number }>();
  return result !== null;
}

/** Validates a CSRF token supplied by a server-rendered same-origin form. */
export async function requireCsrfValue(
  db: D1Database,
  session: DashboardSession,
  supplied: string,
): Promise<boolean> {
  if (supplied.length === 0 || supplied.length > 256) return false;
  const suppliedHash = await sha256Base64(supplied);
  const result = await db
    .prepare(
      `SELECT 1
         FROM sessions
        WHERE id_hash = ? AND csrf_token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(session.idHash, suppliedHash)
    .first<{ 1: number }>();
  return result !== null;
}

/** Deletes the current session so its cookie can no longer authenticate. */
export async function revokeSession(db: D1Database, session: DashboardSession): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?")
    .bind(new Date().toISOString(), session.idHash)
    .run();
}

/** Creates the clearing cookie returned for missing or expired sessions. */
export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Returns whether a mutation originates from the request URL's own origin. */
export function originMatches(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

/** Decodes the opaque token portion used by session-focused tests. */
export function decodeSessionTokenForTest(token: string): Uint8Array<ArrayBuffer> {
  return utf8(token);
}
