import {
  buildCloudflareAuthorizationUrl,
  discoverCloudflareIdentity,
  exchangeCloudflareAuthorizationCode,
  fetchCloudflareUserId,
  type Fetcher,
} from "../adapters/cloudflare-identity";
import {
  consumeLoginRequest,
  deleteOwnerMetadata,
  findControlSession,
  revokeControlSession,
  storeAuditEvent,
  storeControlSession,
  storeLoginRequest,
  upsertOwner,
  type ControlSessionRecord,
} from "../adapters/control-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import {
  constantTimeEqual,
  randomToken,
  sha256Base64Url,
} from "../security/encoding";

const OAUTH_REQUEST_TTL_SECONDS = 600;

export interface LoginRedirect {
  location: string;
  state: string;
}

export interface CompletedLogin {
  csrfToken: string;
  ownerId: string;
  sessionToken: string;
}

/** Creates a single-use identity request and returns its Cloudflare redirect. */
export async function startIdentityLogin(
  database: D1Database,
  config: ControlConfig,
  fetcher: Fetcher = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<LoginRedirect> {
  let discovery: Awaited<ReturnType<typeof discoverCloudflareIdentity>>;
  try {
    discovery = await discoverCloudflareIdentity(config, fetcher);
  } catch {
    throw new ControlPlaneError(
      "identity_provider_unavailable",
      503,
      "identity_discovery_failed",
    );
  }
  let state: string;
  let codeVerifier: string;
  let codeChallenge: string;
  let stateHash: string;
  try {
    state = randomToken();
    codeVerifier = randomToken(64);
    codeChallenge = await sha256Base64Url(codeVerifier);
    stateHash = await sha256Base64Url(state);
  } catch {
    throw new ControlPlaneError(
      "identity_provider_unavailable",
      503,
      "identity_state_generation_failed",
    );
  }
  try {
    await storeLoginRequest(database, {
      stateHash,
      codeVerifier,
      returnPath: "/",
      createdAt: nowSeconds,
      expiresAt: nowSeconds + OAUTH_REQUEST_TTL_SECONDS,
    });
  } catch {
    throw new ControlPlaneError(
      "identity_provider_unavailable",
      503,
      "identity_state_storage_failed",
    );
  }
  return {
    location: buildCloudflareAuthorizationUrl(
      discovery,
      config,
      state,
      codeChallenge,
    ).toString(),
    state,
  };
}

/** Completes Cloudflare identity login and issues opaque local session credentials. */
export async function completeIdentityLogin(
  database: D1Database,
  config: ControlConfig,
  input: { code: string; state: string; cookieState: string },
  fetcher: Fetcher = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CompletedLogin> {
  if (
    !/^[A-Za-z0-9_-]{32,256}$/u.test(input.state) ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(input.cookieState)
  ) {
    throw new ControlPlaneError("identity_callback_rejected", 401);
  }
  if (!constantTimeEqual(input.state, input.cookieState)) {
    throw new ControlPlaneError("identity_callback_rejected", 401);
  }
  const request = await consumeLoginRequest(
    database,
    await sha256Base64Url(input.state),
    nowSeconds,
  );
  if (request === null) throw new ControlPlaneError("identity_callback_rejected", 401);
  const discovery = await discoverCloudflareIdentity(config, fetcher);
  const accessToken = await exchangeCloudflareAuthorizationCode(
    discovery,
    config,
    input.code,
    request.codeVerifier,
    fetcher,
  );
  const cloudflareUserId = await fetchCloudflareUserId(accessToken, fetcher);
  const subjectHash = await sha256Base64Url(`cloudflare-user\u0000${cloudflareUserId}`);
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
