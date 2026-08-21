import {
  authenticateControlSession,
  authorizeControlMutation,
  completeIdentityLogin,
  controlCsrfCookieMatches,
  deleteControlIdentityMetadata,
  logoutControlSession,
  startIdentityLogin,
} from "./application/identity";
import {
  completeInstallerAuthorization,
  startInstallerAuthorization,
} from "./application/installer";
import { provisionOwnerInstallation } from "./application/provisioning";
import { cleanupOwnerInstallation } from "./application/cleanup";
import { updateOwnerRuntime } from "./application/updates";
import {
  completeRuntimeLogin,
  startRuntimeLogin,
} from "./application/runtime-login";
import {
  loadRuntimeRelease,
  signedRuntimeReleaseManifest,
} from "./application/releases";
import { configureRolloutCampaign } from "./adapters/release-repository";
import {
  publicModelCatalog,
  publicStoragePlanCatalog,
} from "./application/catalogs";
import {
  completeExtensionPairing,
  startExtensionPairing,
} from "./application/extension-pairing";
import { readControlConfig, type ControlConfig } from "./domain/config";
import { ControlPlaneError } from "./domain/errors";
import { logControlEvent } from "./observability/events";
import { renderDashboard, renderErrorPage, renderSignedOutPage } from "./routes/pages";
import {
  CSRF_COOKIE,
  EXTENSION_REQUEST_COOKIE,
  expireCookie,
  INSTALLER_STATE_COOKIE,
  OAUTH_STATE_COOKIE,
  readCookie,
  RUNTIME_LOGIN_COOKIE,
  serializeCookie,
  SESSION_COOKIE,
} from "./security/cookies";
import {
  parseOwnerAssertionKeyRing,
  publicOwnerAssertionJwks,
} from "./security/owner-assertions";
import {
  findOwnerInstallationSummary,
  findOwnerReleaseHistory,
  revokeInstallerAuthorization,
} from "./adapters/installation-repository";

/** Adds browser security headers to every HTML response. */
function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' https://dash.cloudflare.com; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

/** Returns whether control-plane cookies must carry the Secure attribute. */
function secureCookies(config: ControlConfig): boolean {
  return new URL(config.publicOrigin).protocol === "https:";
}

/** Returns a redirect response with no browser-cache persistence. */
function redirect(location: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: { location, "cache-control": "no-store" },
  });
}

/** Accepts exact Origin or browser fetch metadata when privacy policy omits Origin. */
function isSameOriginMutation(request: Request, config: ControlConfig): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") return origin === config.publicOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin" &&
    new URL(request.url).origin === config.publicOrigin;
}

/** Validates a short OAuth callback parameter without retaining provider error text. */
function callbackParameter(url: URL, name: "code" | "state"): string {
  const value = url.searchParams.get(name);
  const maximumLength = name === "state" ? 256 : 8192;
  if (value === null || value.length < 8 || value.length > maximumLength) {
    throw new ControlPlaneError("identity_callback_rejected", 401);
  }
  return value;
}

/** Serves the signed-in or signed-out control-plane home page. */
async function handleHome(request: Request, env: Env, config: ControlConfig): Promise<Response> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const csrfToken = readCookie(request, CSRF_COOKIE);
  if (sessionToken === null && csrfToken === null) return htmlResponse(renderSignedOutPage());
  if (sessionToken === null || csrfToken === null) return expiredControlSession(config);
  const session = await authenticateControlSession(env.CONTROL_DB, sessionToken);
  if (session === null || !await controlCsrfCookieMatches(session, csrfToken)) {
    return expiredControlSession(config);
  }
  const [installation, releases] = await Promise.all([
    findOwnerInstallationSummary(env.CONTROL_DB, session.ownerId),
    findOwnerReleaseHistory(env.CONTROL_DB, session.ownerId),
  ]);
  return htmlResponse(renderDashboard(csrfToken, installation, releases));
}

/** Clears an unusable session pair before rendering another actionable page. */
function expiredControlSession(config: ControlConfig): Response {
  const response = htmlResponse(renderSignedOutPage());
  const secure = secureCookies(config);
  response.headers.append("set-cookie", expireCookie(SESSION_COOKIE, secure));
  response.headers.append("set-cookie", expireCookie(CSRF_COOKIE, secure));
  return response;
}

/** Starts identity-only Cloudflare OAuth and stores no deployment authorization. */
async function handleIdentityStart(env: Env, config: ControlConfig, requestId: string): Promise<Response> {
  const login = await startIdentityLogin(env.CONTROL_DB, config);
  const response = redirect(login.location, 302);
  response.headers.append(
    "set-cookie",
    serializeCookie(OAUTH_STATE_COOKIE, login.state, {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax",
      secure: secureCookies(config),
    }),
  );
  logControlEvent("identity_login_started", requestId, "redirected");
  return response;
}

/** Completes the identity callback and creates a local opaque session. */
async function handleIdentityCallback(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has("error")) {
    throw new ControlPlaneError("identity_callback_rejected", 401);
  }
  const cookieState = readCookie(request, OAUTH_STATE_COOKIE);
  if (cookieState === null) throw new ControlPlaneError("identity_callback_rejected", 401);
  const login = await completeIdentityLogin(env.CONTROL_DB, config, {
    code: callbackParameter(url, "code"),
    state: callbackParameter(url, "state"),
    cookieState,
  });
  const secure = secureCookies(config);
  const response = redirect("/");
  response.headers.append(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, login.sessionToken, {
      httpOnly: true,
      maxAge: config.sessionTtlSeconds,
      sameSite: "Lax",
      secure,
    }),
  );
  response.headers.append(
    "set-cookie",
    serializeCookie(CSRF_COOKIE, login.csrfToken, {
      httpOnly: false,
      maxAge: config.sessionTtlSeconds,
      sameSite: "Lax",
      secure,
    }),
  );
  response.headers.append("set-cookie", expireCookie(OAUTH_STATE_COOKIE, secure));
  logControlEvent("identity_login_succeeded", requestId, "session_created");
  const extensionRequest = readCookie(request, EXTENSION_REQUEST_COOKIE);
  const runtimeRequest = readCookie(request, RUNTIME_LOGIN_COOKIE);
  if (extensionRequest !== null) {
    response.headers.set("location", "/extension/connect/resume");
  } else if (runtimeRequest !== null) {
    response.headers.set("location", "/runtime/login/resume");
  }
  return response;
}

/** Starts an installation-bound personal-runtime login, reusing a live control session. */
async function handleRuntimeLoginStart(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const pending = await startRuntimeLogin(env.CONTROL_DB, new URL(request.url));
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const session = sessionToken === null
    ? null
    : await authenticateControlSession(env.CONTROL_DB, sessionToken);
  let response: Response;
  if (session !== null && session.ownerId === pending.ownerId) {
    response = redirect("/runtime/login/resume", 302);
  } else {
    response = await handleIdentityStart(env, config, requestId);
  }
  response.headers.append(
    "set-cookie",
    serializeCookie(RUNTIME_LOGIN_COOKIE, pending.requestToken, {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax",
      secure: secureCookies(config),
    }),
  );
  logControlEvent("runtime_login_started", requestId, session === null ? "identity_required" : "session_reused");
  return response;
}

/** Completes a personal-runtime login only for its authenticated installation owner. */
async function handleRuntimeLoginResume(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const requestToken = readCookie(request, RUNTIME_LOGIN_COOKIE);
  if (sessionToken === null || requestToken === null) {
    throw new ControlPlaneError("session_invalid", 403);
  }
  const session = await authenticateControlSession(env.CONTROL_DB, sessionToken);
  if (session === null) throw new ControlPlaneError("session_invalid", 403);
  const destination = await completeRuntimeLogin(
    env.CONTROL_DB,
    config,
    env.OWNER_ASSERTION_SIGNING_KEYS,
    session.ownerId,
    requestToken,
  );
  const response = redirect(destination, 302);
  response.headers.append(
    "set-cookie",
    expireCookie(RUNTIME_LOGIN_COOKIE, secureCookies(config)),
  );
  logControlEvent("runtime_login_issued", requestId, "assertion_created");
  return response;
}

/** Starts Chrome identity pairing, reusing an existing Cloudflare session when present. */
async function handleExtensionConnect(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const requestToken = await startExtensionPairing(
    env.CONTROL_DB,
    config,
    new URL(request.url),
  );
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const session = sessionToken === null
    ? null
    : await authenticateControlSession(env.CONTROL_DB, sessionToken);
  if (session !== null) {
    const destination = await completeExtensionPairing(
      env.CONTROL_DB,
      config,
      env.OWNER_ASSERTION_SIGNING_KEYS,
      session.ownerId,
      requestToken,
    );
    logControlEvent("extension_pairing_issued", requestId, "existing_session");
    return redirect(destination, 302);
  }
  const login = await startIdentityLogin(env.CONTROL_DB, config);
  const response = redirect(login.location, 302);
  const secure = secureCookies(config);
  response.headers.append(
    "set-cookie",
    serializeCookie(OAUTH_STATE_COOKIE, login.state, {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax",
      secure,
    }),
  );
  response.headers.append(
    "set-cookie",
    serializeCookie(EXTENSION_REQUEST_COOKIE, requestToken, {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax",
      secure,
    }),
  );
  logControlEvent("extension_pairing_started", requestId, "identity_required");
  return response;
}

/** Completes Chrome pairing after Cloudflare identity created a control session. */
async function handleExtensionConnectResume(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const requestToken = readCookie(request, EXTENSION_REQUEST_COOKIE);
  if (sessionToken === null || requestToken === null) {
    throw new ControlPlaneError("extension_request_rejected", 401);
  }
  const session = await authenticateControlSession(env.CONTROL_DB, sessionToken);
  if (session === null) throw new ControlPlaneError("session_invalid", 403);
  const destination = await completeExtensionPairing(
    env.CONTROL_DB,
    config,
    env.OWNER_ASSERTION_SIGNING_KEYS,
    session.ownerId,
    requestToken,
  );
  const response = redirect(destination, 302);
  response.headers.append(
    "set-cookie",
    expireCookie(EXTENSION_REQUEST_COOKIE, secureCookies(config)),
  );
  logControlEvent("extension_pairing_issued", requestId, "identity_completed");
  return response;
}

/** Enforces same-origin CSRF before revoking the local control-plane session. */
async function handleLogout(request: Request, env: Env, config: ControlConfig, requestId: string): Promise<Response> {
  if (!isSameOriginMutation(request, config)) {
    throw new ControlPlaneError("session_invalid", 403, "session_origin_invalid");
  }
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const csrfCookie = readCookie(request, CSRF_COOKIE);
  if (sessionToken === null || csrfCookie === null) {
    throw new ControlPlaneError("session_invalid", 403, "session_cookie_missing");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new ControlPlaneError("bad_request", 400, "session_content_type_invalid");
  }
  const form = await request.formData();
  const csrf = form.get("csrf");
  if (typeof csrf !== "string" || csrf.length > 512) {
    throw new ControlPlaneError("session_invalid", 403, "session_form_csrf_invalid");
  }
  await logoutControlSession(env.CONTROL_DB, sessionToken, csrf, csrfCookie);
  const secure = secureCookies(config);
  const response = redirect("/");
  response.headers.append("set-cookie", expireCookie(SESSION_COOKIE, secure));
  response.headers.append("set-cookie", expireCookie(CSRF_COOKIE, secure));
  logControlEvent("identity_logout_succeeded", requestId, "session_revoked");
  return response;
}

/** Deletes authenticated control-plane identity metadata after explicit CSRF-protected confirmation. */
async function handleIdentityDeletion(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  if (!isSameOriginMutation(request, config)) {
    throw new ControlPlaneError("session_invalid", 403);
  }
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const csrfCookie = readCookie(request, CSRF_COOKIE);
  if (sessionToken === null || csrfCookie === null) {
    throw new ControlPlaneError("session_invalid", 403);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new ControlPlaneError("bad_request", 400);
  }
  const form = await request.formData();
  const csrf = form.get("csrf");
  const confirmation = form.get("confirmation");
  if (
    typeof csrf !== "string" ||
    csrf.length > 512 ||
    confirmation !== "delete-control-metadata"
  ) {
    throw new ControlPlaneError("session_invalid", 403);
  }
  await deleteControlIdentityMetadata(env.CONTROL_DB, sessionToken, csrf, csrfCookie);
  const secure = secureCookies(config);
  const response = redirect("/");
  response.headers.append("set-cookie", expireCookie(SESSION_COOKIE, secure));
  response.headers.append("set-cookie", expireCookie(CSRF_COOKIE, secure));
  logControlEvent("owner_metadata_deleted", requestId, "deleted");
  return response;
}

/** Validates one authenticated form mutation and returns its owner identity. */
async function authenticatedFormOwner(
  request: Request,
  env: Env,
  config: ControlConfig,
): Promise<string> {
  if (!isSameOriginMutation(request, config)) {
    throw new ControlPlaneError("session_invalid", 403, "session_origin_invalid");
  }
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const csrfCookie = readCookie(request, CSRF_COOKIE);
  if (sessionToken === null || csrfCookie === null) {
    throw new ControlPlaneError("session_invalid", 403, "session_cookie_missing");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new ControlPlaneError("bad_request", 400, "session_content_type_invalid");
  }
  const form = await request.clone().formData();
  const csrf = form.get("csrf");
  if (typeof csrf !== "string" || csrf.length > 512) {
    throw new ControlPlaneError("session_invalid", 403, "session_form_csrf_invalid");
  }
  const authorized = await authorizeControlMutation(
    env.CONTROL_DB,
    sessionToken,
    csrf,
    csrfCookie,
    Math.floor(Date.now() / 1000),
  );
  return authorized.session.ownerId;
}

/** Starts purpose-specific installer authorization after the owner chooses KV or R2. */
async function handleInstallerStart(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const ownerId = await authenticatedFormOwner(request, env, config);
  const form = await request.formData();
  const storageMode = form.get("storage_mode");
  if (storageMode !== "kv" && storageMode !== "r2") {
    throw new ControlPlaneError("bad_request", 400);
  }
  const authorization = await startInstallerAuthorization(
    env.CONTROL_DB,
    config,
    ownerId,
    storageMode,
  );
  const response = redirect(authorization.location, 302);
  response.headers.append(
    "set-cookie",
    serializeCookie(INSTALLER_STATE_COOKIE, authorization.state, {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax",
      secure: secureCookies(config),
    }),
  );
  logControlEvent("installer_authorization_started", requestId, storageMode);
  return response;
}

/** Completes installer consent only for the same live owner session. */
async function handleInstallerCallback(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const cookieState = readCookie(request, INSTALLER_STATE_COOKIE);
  if (sessionToken === null || cookieState === null) {
    throw new ControlPlaneError("installer_callback_rejected", 401);
  }
  const session = await authenticateControlSession(env.CONTROL_DB, sessionToken);
  if (session === null) throw new ControlPlaneError("session_invalid", 403);
  const url = new URL(request.url);
  if (url.searchParams.has("error")) {
    throw new ControlPlaneError("installer_callback_rejected", 401);
  }
  await completeInstallerAuthorization(env.CONTROL_DB, config, {
    code: callbackParameter(url, "code"),
    state: callbackParameter(url, "state"),
    cookieState,
    ownerId: session.ownerId,
  });
  const response = redirect("/");
  response.headers.append(
    "set-cookie",
    expireCookie(INSTALLER_STATE_COOKIE, secureCookies(config)),
  );
  logControlEvent("installer_authorization_succeeded", requestId, "plan_created");
  return response;
}

/** Advances an authorized installation while duplicate form submissions remain idempotent. */
async function handleProvisioning(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const ownerId = await authenticatedFormOwner(request, env, config);
  const outcome = await provisionOwnerInstallation(
    env.CONTROL_DB,
    env.RELEASE_ARTIFACTS,
    config,
    ownerId,
  );
  logControlEvent("installer_provisioning_advanced", requestId, outcome.status);
  return redirect("/");
}

/** Revokes renewable deployment authority without changing the personal runtime. */
async function handleInstallerRevocation(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const ownerId = await authenticatedFormOwner(request, env, config);
  const form = await request.formData();
  if (form.get("confirmation") !== "revoke-installer-authorization") {
    throw new ControlPlaneError("bad_request", 400);
  }
  await revokeInstallerAuthorization(env.CONTROL_DB, ownerId, Math.floor(Date.now() / 1000));
  logControlEvent("installer_authorization_revoked", requestId, "revoked");
  return redirect("/");
}

/** Executes explicit compensating cleanup for an incomplete personal installation. */
async function handleInstallationCleanup(
  request: Request,
  env: Env,
  config: ControlConfig,
  requestId: string,
): Promise<Response> {
  const ownerId = await authenticatedFormOwner(request, env, config);
  const form = await request.formData();
  if (form.get("confirmation") !== "delete-created-resources") {
    throw new ControlPlaneError("bad_request", 400);
  }
  await cleanupOwnerInstallation(env.CONTROL_DB, config, ownerId);
  logControlEvent("installer_cleanup_completed", requestId, "deleted");
  return redirect("/");
}

/** Publishes public assertion keys while retaining all private signing material. */
function handleOwnerAssertionKeys(env: Env): Response {
  const keys = publicOwnerAssertionJwks(
    parseOwnerAssertionKeyRing(env.OWNER_ASSERTION_SIGNING_KEYS),
  );
  return Response.json(keys, {
    headers: {
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Serves one signed public catalog with bounded cache lifetime and no owner lookup. */
async function handlePublicCatalog(
  env: Env,
  kind: "models" | "storage-plans",
): Promise<Response> {
  const catalog = kind === "models"
    ? await publicModelCatalog(env.OWNER_ASSERTION_SIGNING_KEYS)
    : await publicStoragePlanCatalog(env.OWNER_ASSERTION_SIGNING_KEYS);
  return Response.json(catalog, {
    headers: {
      "cache-control": "public, max-age=300, stale-if-error=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Publishes one signed, privacy-safe runtime compatibility manifest. */
async function handleRuntimeReleaseManifest(env: Env, release: string): Promise<Response> {
  const artifact = await loadRuntimeRelease(env.RELEASE_ARTIFACTS, release);
  const manifest = await signedRuntimeReleaseManifest(
    artifact,
    env.OWNER_ASSERTION_SIGNING_KEYS,
  );
  return Response.json(manifest, {
    headers: {
      "cache-control": "public, max-age=300, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Routes control-plane traffic without proxying personal application requests. */
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        { contractVersion: 1, service: "later-gator-control-plane", status: "ready" },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const config = readControlConfig(env);
    if (url.origin !== config.publicOrigin) throw new ControlPlaneError("bad_request", 400);
    if (url.pathname === "/.well-known/later-gator-jwks.json" && request.method === "GET") {
      return handleOwnerAssertionKeys(env);
    }
    if (url.pathname === "/catalogs/models" && request.method === "GET") {
      return await handlePublicCatalog(env, "models");
    }
    if (url.pathname === "/catalogs/storage-plans" && request.method === "GET") {
      return await handlePublicCatalog(env, "storage-plans");
    }
    const releasePath = /^\/releases\/runtime\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u
      .exec(url.pathname);
    if (releasePath !== null && request.method === "GET") {
      const release = releasePath[1];
      if (release === undefined) throw new ControlPlaneError("not_found", 404);
      return await handleRuntimeReleaseManifest(env, release);
    }
    if (url.pathname === "/extension/connect" && request.method === "GET") {
      return await handleExtensionConnect(request, env, config, requestId);
    }
    if (url.pathname === "/extension/connect/resume" && request.method === "GET") {
      return await handleExtensionConnectResume(request, env, config, requestId);
    }
    if (url.pathname === "/runtime/login" && request.method === "GET") {
      return await handleRuntimeLoginStart(request, env, config, requestId);
    }
    if (url.pathname === "/runtime/login/resume" && request.method === "GET") {
      return await handleRuntimeLoginResume(request, env, config, requestId);
    }
    if (url.pathname === "/" && request.method === "GET") return await handleHome(request, env, config);
    if (url.pathname === "/auth/cloudflare" && request.method === "GET") {
      return await handleIdentityStart(env, config, requestId);
    }
    if (url.pathname === "/auth/cloudflare/callback" && request.method === "GET") {
      return await handleIdentityCallback(request, env, config, requestId);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return await handleLogout(request, env, config, requestId);
    }
    if (url.pathname === "/install/authorize" && request.method === "POST") {
      return await handleInstallerStart(request, env, config, requestId);
    }
    if (url.pathname === "/install/cloudflare/callback" && request.method === "GET") {
      return await handleInstallerCallback(request, env, config, requestId);
    }
    if (url.pathname === "/install/provision" && request.method === "POST") {
      return await handleProvisioning(request, env, config, requestId);
    }
    if (url.pathname === "/install/revoke" && request.method === "POST") {
      return await handleInstallerRevocation(request, env, config, requestId);
    }
    if (url.pathname === "/install/cleanup" && request.method === "POST") {
      return await handleInstallationCleanup(request, env, config, requestId);
    }
    if (url.pathname === "/account/delete" && request.method === "POST") {
      return await handleIdentityDeletion(request, env, config, requestId);
    }
    if (
      [
        "/",
        "/.well-known/later-gator-jwks.json",
        "/catalogs/models",
        "/catalogs/storage-plans",
        "/extension/connect",
        "/extension/connect/resume",
        "/runtime/login",
        "/runtime/login/resume",
        "/auth/cloudflare",
        "/auth/cloudflare/callback",
        "/auth/logout",
        "/account/delete",
        "/install/authorize",
        "/install/cloudflare/callback",
        "/install/provision",
        "/install/revoke",
        "/install/cleanup",
      ].includes(url.pathname)
    ) {
      throw new ControlPlaneError("method_not_allowed", 405);
    }
    throw new ControlPlaneError("not_found", 404);
  } catch (error: unknown) {
    const controlled = error instanceof ControlPlaneError
      ? error
      : new ControlPlaneError("identity_provider_unavailable", 503);
    logControlEvent("request_failed", requestId, controlled.failureStage ?? controlled.code);
    return htmlResponse(renderErrorPage(controlled.code), controlled.status);
  }
}

/** Advances a bounded release cohort without proxying personal application traffic. */
async function handleScheduledUpdate(env: Env): Promise<void> {
  const release = env.ACTIVE_RUNTIME_RELEASE;
  const cohortCeiling = Number(env.ROLLOUT_COHORT_CEILING);
  const failureThreshold = Number(env.ROLLOUT_FAILURE_THRESHOLD_PERCENT);
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release) ||
    !Number.isInteger(cohortCeiling) || cohortCeiling < 0 || cohortCeiling > 100 ||
    !Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 100
  ) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  await configureRolloutCampaign(
    env.CONTROL_DB,
    release,
    cohortCeiling,
    failureThreshold,
    nowSeconds,
  );
  const candidates = await env.CONTROL_DB.prepare(
    `SELECT owner_id FROM installations
      WHERE status = 'ready' AND installed_release <> ? AND rollout_cohort < ?
      ORDER BY updated_at ASC LIMIT 10`,
  ).bind(release, cohortCeiling).all<{ owner_id: string }>();
  const config = readControlConfig(env);
  for (const candidate of candidates.results) {
    await updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      candidate.owner_id,
      release,
    );
  }
}

export default {
  fetch: handleRequest,
  /** Schedules one bounded managed-release cohort update. */
  scheduled(_controller, env, context): void {
    context.waitUntil(handleScheduledUpdate(env));
  },
} satisfies ExportedHandler<Env>;
