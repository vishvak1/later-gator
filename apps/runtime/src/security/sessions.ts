import { randomBytes, sha256Base64, toBase64 } from "./encoding";

const SESSION_COOKIE = "lg_session";
const IDLE_MILLISECONDS = 24 * 60 * 60 * 1000;
const ABSOLUTE_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;

interface SessionRow {
  id_hash: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
}

export interface DashboardSession {
  idHash: string;
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

/** Persists only hashed session and CSRF credentials and returns browser cookie values. */
export async function createSession(
  db: D1Database,
): Promise<{ cookie: string; csrfToken: string }> {
  const token = toBase64(randomBytes(32));
  const csrfToken = toBase64(randomBytes(32));
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + IDLE_MILLISECONDS).toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_MILLISECONDS).toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (
        id_hash, csrf_token_hash, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      await sha256Base64(token),
      await sha256Base64(csrfToken),
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

/** Validates a hashed session cookie and its bounded idle and absolute lifetimes. */
export async function loadSession(
  request: Request,
  db: D1Database,
): Promise<DashboardSession | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null || token.length > 256) return null;
  const idHash = await sha256Base64(token);
  const row = await db
    .prepare(
      `SELECT id_hash, idle_expires_at, absolute_expires_at, revoked_at
         FROM sessions
        WHERE id_hash = ?`,
    )
    .bind(idHash)
    .first<SessionRow>();
  const now = Date.now();
  if (
    row?.revoked_at !== null ||
    Date.parse(row.idle_expires_at) <= now ||
    Date.parse(row.absolute_expires_at) <= now
  ) {
    return null;
  }
  return { idHash: row.id_hash };
}

/** Validates the submitted CSRF token against the authenticated session hash. */
export async function requireCsrf(
  request: Request,
  db: D1Database,
  session: DashboardSession,
): Promise<boolean> {
  const supplied = request.headers.get("x-csrf-token");
  return supplied === null ? false : requireCsrfValue(db, session, supplied);
}

/** Validates a CSRF token supplied by a server-rendered same-origin form. */
export async function requireCsrfValue(
  db: D1Database,
  session: DashboardSession,
  supplied: string,
): Promise<boolean> {
  if (supplied.length === 0 || supplied.length > 256) return false;
  const result = await db
    .prepare(
      `SELECT 1
         FROM sessions
        WHERE id_hash = ? AND csrf_token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(session.idHash, await sha256Base64(supplied))
    .first<{ 1: number }>();
  return result !== null;
}

/** Rotates the CSRF credential for an already authenticated dashboard session. */
export async function refreshSessionCsrf(
  db: D1Database,
  session: DashboardSession,
): Promise<{ cookie: string; csrfToken: string }> {
  const csrfToken = toBase64(randomBytes(32));
  await db
    .prepare(
      `UPDATE sessions
          SET csrf_token_hash = ?
        WHERE id_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await sha256Base64(csrfToken), session.idHash)
    .run();
  return { cookie: csrfCookie(csrfToken), csrfToken };
}

/** Revokes the current session without affecting any other device. */
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

/** Creates the readable CSRF cookie paired with a newly created session. */
export function csrfCookie(csrfToken: string): string {
  return `lg_csrf=${csrfToken}; Path=/; Secure; SameSite=Lax; Max-Age=${(
    ABSOLUTE_MILLISECONDS / 1000
  ).toString()}`;
}

/** Creates the clearing CSRF cookie returned for missing or expired sessions. */
export function expiredCsrfCookie(): string {
  return "lg_csrf=; Path=/; Secure; SameSite=Lax; Max-Age=0";
}

/** Returns whether a mutation originates from the request URL's own origin. */
export function originMatches(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}
