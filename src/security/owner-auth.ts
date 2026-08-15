import { sha256Base64 } from "./encoding";
import { unlockOrInitializeVault } from "./password-vault";

export type OwnerAuthenticationResult =
  | { status: "authenticated"; rawDataKey: Uint8Array<ArrayBuffer> }
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
  const existing = await db
    .prepare(
      "SELECT window_started_at, failure_count FROM login_attempts WHERE client_hash = ?",
    )
    .bind(clientHash)
    .first<{ window_started_at: string; failure_count: number }>();
  const now = new Date();
  const inWindow =
    existing !== null && Date.parse(existing.window_started_at) > now.getTime() - 15 * 60 * 1000;
  const failureCount = inWindow ? existing.failure_count + 1 : 1;
  const blockedUntil =
    failureCount >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
  await db
    .prepare(
      `INSERT INTO login_attempts (
        client_hash, window_started_at, failure_count, blocked_until
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_hash) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        failure_count = excluded.failure_count,
        blocked_until = excluded.blocked_until`,
    )
    .bind(
      clientHash,
      inWindow ? existing.window_started_at : now.toISOString(),
      failureCount,
      blockedUntil,
    )
    .run();
}

/** Verifies the owner's existing Later Gator password for dashboard and OAuth login. */
export async function authenticateOwnerPassword(
  request: Request,
  env: Env,
  password: string,
): Promise<OwnerAuthenticationResult> {
  if (await loginIsBlocked(request, env.DB)) return { status: "rate_limited" };

  let unlocked: Awaited<ReturnType<typeof unlockOrInitializeVault>>;
  try {
    unlocked = await unlockOrInitializeVault(env.DB, env, password);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "authentication_vault_unavailable",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return { status: "unavailable" };
  }

  if (unlocked === null) {
    await recordLoginFailure(request, env.DB);
    return { status: "invalid" };
  }

  await env.DB
    .prepare("DELETE FROM login_attempts WHERE client_hash = ?")
    .bind(await loginClientHash(request))
    .run();
  return { status: "authenticated", rawDataKey: unlocked.rawDataKey };
}
