import { constantTimeEqual, sha256Base64 } from "./encoding";

export type OwnerAuthenticationResult =
  | { status: "authenticated" }
  | { status: "invalid" }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/** Hashes privacy-preserving client metadata for owner-login throttling. */
async function loginClientHash(request: Request): Promise<string> {
  const client = request.headers.get("cf-connecting-ip") ?? "local";
  return sha256Base64(`login-client:${client}`);
}
/** Returns whether the requesting client is inside an active login block. */
async function loginIsBlocked(request: Request, db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT blocked_until FROM login_attempts WHERE client_hash = ?")
    .bind(await loginClientHash(request))
    .first<{ blocked_until: string | null }>();
  return row?.blocked_until !== null &&
    row?.blocked_until !== undefined &&
    Date.parse(row.blocked_until) > Date.now();
}

/** Records one failed owner-login attempt inside the bounded throttle window. */
async function recordLoginFailure(request: Request, db: D1Database): Promise<void> {
  const clientHash = await loginClientHash(request);
  const now = new Date();
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const blockedUntil = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  await db.prepare(
    `INSERT INTO login_attempts (client_hash, window_started_at, failure_count, blocked_until)
     VALUES (?, ?, 1, NULL)
     ON CONFLICT(client_hash) DO UPDATE SET
       failure_count = CASE WHEN login_attempts.window_started_at > ?
         THEN login_attempts.failure_count + 1 ELSE 1 END,
       blocked_until = CASE WHEN login_attempts.window_started_at > ?
         AND login_attempts.failure_count >= 4 THEN ? ELSE NULL END,
       window_started_at = CASE WHEN login_attempts.window_started_at > ?
         THEN login_attempts.window_started_at ELSE excluded.window_started_at END`,
  ).bind(clientHash, now.toISOString(), cutoff, cutoff, blockedUntil, cutoff).run();
}

/** Verifies the owner's existing Later Gator password for dashboard and OAuth login. */
export async function authenticateOwnerPassword(
  request: Request,
  env: Env,
  password: string,
): Promise<OwnerAuthenticationResult> {
  if (await loginIsBlocked(request, env.DB)) return { status: "rate_limited" };

  if (typeof env.PASSWORD !== "string" || env.PASSWORD.length < 16) {
    return { status: "unavailable" };
  }
  const valid = constantTimeEqual(await sha256Base64(password), await sha256Base64(env.PASSWORD));
  if (!valid) {
    await recordLoginFailure(request, env.DB);
    return { status: "invalid" };
  }

  await env.DB
    .prepare("DELETE FROM login_attempts WHERE client_hash = ?")
    .bind(await loginClientHash(request))
    .run();
  return { status: "authenticated" };
}
