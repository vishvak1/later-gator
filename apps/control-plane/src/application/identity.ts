import { authenticateCloudflareAccess } from "../adapters/cloudflare-access";
import type { Fetcher } from "../adapters/cloudflare-identity";
import {
  deleteOwnerMetadata,
  findControlSession,
  revokeControlSession,
  storeAuditEvent,
  storeControlSession,
  upsertOwner,
  type ControlSessionRecord,
} from "../adapters/control-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import {
  constantTimeEqual, randomToken, sha256Base64Url,
} from "../security/encoding";

export interface CompletedLogin {
  csrfToken: string;
  ownerId: string;
  sessionToken: string;
}

/** Converts one validated Cloudflare Access identity into an opaque local session. */
export async function completeAccessLogin(
  database: D1Database,
  config: ControlConfig,
  request: Request,
  fetcher: Fetcher = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CompletedLogin> {
  const identity = await authenticateCloudflareAccess(request, config, fetcher);
  const subjectHash = await sha256Base64Url(`cloudflare-account-email\u0000${identity.email}`);
  const ownerId = await upsertOwner(database, subjectHash, nowSeconds);
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  await storeControlSession(database, {
    sessionHash: await sha256Base64Url(sessionToken),
    ownerId,
    csrfHash: await sha256Base64Url(csrfToken),
    createdAt: nowSeconds,
    expiresAt: nowSeconds + config.sessionTtlSeconds,
  });
  await storeAuditEvent(database, ownerId, "identity_login_succeeded", nowSeconds);
  return { csrfToken, ownerId, sessionToken };
}

/** Resolves an opaque control-plane session cookie to safe owner metadata. */
export async function authenticateControlSession(
  database: D1Database,
  sessionToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ControlSessionRecord | null> {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(sessionToken)) return null;
  return findControlSession(database, await sha256Base64Url(sessionToken), nowSeconds);
}

/** Validates the readable CSRF cookie against the hash bound to one live session. */
export async function controlCsrfCookieMatches(
  session: ControlSessionRecord,
  csrfToken: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{32,512}$/u.test(csrfToken)) return false;
  return constantTimeEqual(await sha256Base64Url(csrfToken), session.csrfHash);
}

/** Authorizes a control-plane mutation against one live session and CSRF token. */
export async function authorizeControlMutation(
  database: D1Database,
  sessionToken: string,
  csrfToken: string,
  csrfCookie: string,
  nowSeconds: number,
): Promise<{ sessionHash: string; session: ControlSessionRecord }> {
  if (
    !/^[A-Za-z0-9_-]{32,256}$/u.test(sessionToken) ||
    !/^[A-Za-z0-9_-]{32,512}$/u.test(csrfToken) ||
    !/^[A-Za-z0-9_-]{32,512}$/u.test(csrfCookie)
  ) {
    throw new ControlPlaneError("session_invalid", 403, "session_credential_invalid");
  }
  if (!constantTimeEqual(csrfToken, csrfCookie)) {
    throw new ControlPlaneError("session_invalid", 403, "session_cookie_mismatch");
  }
  const sessionHash = await sha256Base64Url(sessionToken);
  const session = await findControlSession(database, sessionHash, nowSeconds);
  if (session === null) {
    throw new ControlPlaneError("session_invalid", 403, "session_record_invalid");
  }
  if (!await controlCsrfCookieMatches(session, csrfToken)) {
    throw new ControlPlaneError("session_invalid", 403, "session_csrf_binding_invalid");
  }
  return { sessionHash, session };
}

/** Verifies same-session CSRF and revokes the associated session. */
export async function logoutControlSession(
  database: D1Database,
  sessionToken: string,
  csrfToken: string,
  csrfCookie: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { sessionHash, session } = await authorizeControlMutation(
    database,
    sessionToken,
    csrfToken,
    csrfCookie,
    nowSeconds,
  );
  await revokeControlSession(database, sessionHash, nowSeconds);
  await storeAuditEvent(database, session.ownerId, "identity_logout_succeeded", nowSeconds);
  return session.ownerId;
}

/** Verifies the current session and CSRF token, then deletes its owner metadata. */
export async function deleteControlIdentityMetadata(
  database: D1Database,
  sessionToken: string,
  csrfToken: string,
  csrfCookie: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { session } = await authorizeControlMutation(
    database,
    sessionToken,
    csrfToken,
    csrfCookie,
    nowSeconds,
  );
  await deleteOwnerMetadata(database, session.ownerId);
  return session.ownerId;
}
