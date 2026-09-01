import {
  AuthorizationError,
  getOAuthApi,
  OAuthProvider,
  type AuthRequest,
  type ClientInfo,
  type GrantSummary,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { fromBase64, sha256Base64, toBase64, utf8 } from "../security/encoding";
import {
  loadSession,
  originMatches,
  readCookie,
  refreshSessionCsrf,
  requireCsrfValue,
} from "../security/sessions";
import { oauthConsentPage, oauthErrorPage, themeFromCookie } from "./pages";
import { handleMcp } from "./mcp";

const OWNER_ID = "owner";
const LIBRARY_READ_SCOPE = "library:read";
const MCP_LOGIN_RESUME_COOKIE = "__Host-lg_mcp_resume";
const MCP_LOGIN_RESUME_SECONDS = 10 * 60;
const MCP_LOGIN_RESUME_PREFIX = "later-gator:mcp-login-resume:";
const MCP_GRANT_VISIBILITY_GRACE_MS = 5 * 60 * 1000;

const authorizationContinuationSchema = z.strictObject({
  oauthRequest: z.string().min(1).max(16_384),
});

const serializedAuthRequestSchema = z.strictObject({
  responseType: z.string().min(1).max(32),
  clientId: z.string().min(1).max(2048),
  redirectUri: z.url().max(2048),
  scope: z.array(z.string().min(1).max(128)).max(16),
  state: z.string().max(2048),
  codeChallenge: z.string().max(256).optional(),
  codeChallengeMethod: z.string().max(16).optional(),
  resource: z.union([
    z.string().max(2048),
    z.array(z.string().max(2048)).max(8),
  ]).optional(),
  issuer: z.string().max(2048).optional(),
});

interface McpAuthorizationProps {
  connectionId: string;
  permissions: string[];
}
export interface McpConnectionSummary {
  id: string;
  clientType: "chatgpt" | "claude" | "other";
  displayName: string;
  scope: "library:read";
  connectedAt: string;
  lastUsedAt: string | null;
}

interface ConnectionMetadata {
  connectionId: string;
  clientType: McpConnectionSummary["clientType"];
  displayName: string;
  connectedAt: string;
}

/** Handles authenticated MCP calls and updates only privacy-safe connection activity. */
class McpApiHandler extends WorkerEntrypoint<Env, McpAuthorizationProps> {
  /** Passes an OAuth-authenticated request to MCP and records coarse activity. */
  override fetch(request: Request): Promise<Response> {
    this.ctx.waitUntil(markMcpConnectionUsed(this.env.DB, this.ctx.props.connectionId));
    return handleMcp(request, this.env, this.ctx);
  }
}

/** Converts bytes to an unpadded URL-safe base64 value for a hidden form field. */
function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Converts an unpadded URL-safe base64 value back to bytes. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - standard.length % 4) % 4);
  return fromBase64(standard + padding);
}

/** Serializes a validated OAuth request without exposing any Later Gator credential. */
function serializeAuthRequest(request: AuthRequest): string {
  return toBase64Url(utf8(JSON.stringify(request)));
}

/** Parses the bounded OAuth request echoed by the same-origin consent form. */
function deserializeAuthRequest(value: string): AuthRequest | null {
  if (value.length === 0 || value.length > 16_384) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as unknown;
    const parsed = serializedAuthRequestSchema.safeParse(decoded);
    if (!parsed.success) return null;
    return {
      responseType: parsed.data.responseType,
      clientId: parsed.data.clientId,
      redirectUri: parsed.data.redirectUri,
      scope: parsed.data.scope,
      state: parsed.data.state,
      ...(parsed.data.codeChallenge === undefined
        ? {}
        : { codeChallenge: parsed.data.codeChallenge }),
      ...(parsed.data.codeChallengeMethod === undefined
        ? {}
        : { codeChallengeMethod: parsed.data.codeChallengeMethod }),
      ...(parsed.data.resource === undefined ? {} : { resource: parsed.data.resource }),
      ...(parsed.data.issuer === undefined ? {} : { issuer: parsed.data.issuer }),
    };
  } catch {
    return null;
  }
}

/** Builds the private KV key for a short-lived opaque browser continuation. */
async function authorizationContinuationKey(token: string): Promise<string> {
  return MCP_LOGIN_RESUME_PREFIX + await sha256Base64(`mcp-login-resume:${token}`);
}

/** Creates a single-use continuation before sending an unauthenticated owner to login. */
async function beginAuthorizationContinuation(
  request: AuthRequest,
  env: Env,
  origin: string,
): Promise<Response> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(
    await authorizationContinuationKey(token),
    JSON.stringify({ oauthRequest: serializeAuthRequest(request) }),
    { expirationTtl: MCP_LOGIN_RESUME_SECONDS },
  );
  const headers = new Headers({
    location: new URL("/auth/login", origin).toString(),
    "cache-control": "no-store",
  });
  headers.append(
    "set-cookie",
    `${MCP_LOGIN_RESUME_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MCP_LOGIN_RESUME_SECONDS.toString()}`,
  );
  return new Response(null, { status: 302, headers });
}

/** Returns whether the current browser carries an MCP login continuation cookie. */
export function hasPendingMcpAuthorization(request: Request): boolean {
  const token = readCookie(request, MCP_LOGIN_RESUME_COOKIE);
  return token !== null && /^[A-Za-z0-9_-]{40,64}$/u.test(token);
}

/** Creates the cookie that removes a consumed or invalid MCP login continuation. */
function expiredAuthorizationContinuationCookie(): string {
  return `${MCP_LOGIN_RESUME_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Rebuilds a GET authorization request so the provider revalidates submitted form state. */
function authorizationRequestFromSerialized(request: AuthRequest, origin: string): Request {
  const url = new URL("/authorize", origin);
  url.searchParams.set("response_type", request.responseType);
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", request.scope.join(" "));
  url.searchParams.set("state", request.state);
  if (request.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge", request.codeChallenge);
  }
  if (request.codeChallengeMethod !== undefined) {
    url.searchParams.set("code_challenge_method", request.codeChallengeMethod);
  }
  for (const resource of request.resource === undefined
    ? []
    : Array.isArray(request.resource) ? request.resource : [request.resource]) {
    url.searchParams.append("resource", resource);
  }
  return new Request(url, { method: "GET" });
}

/** Classifies a validated OAuth client into a safe owner-facing assistant label. */
function describeClient(client: ClientInfo, request: AuthRequest): {
  clientType: McpConnectionSummary["clientType"];
  displayName: string;
} {
  const evidence = [client.clientId, client.clientName ?? "", request.redirectUri]
    .join(" ")
    .toLowerCase();
  if (evidence.includes("codex")) {
    return { clientType: "other", displayName: "Codex" };
  }
  if (evidence.includes("chatgpt.com") || evidence.includes("openai")) {
    return { clientType: "chatgpt", displayName: "ChatGPT" };
  }
  if (evidence.includes("claude code")) {
    return { clientType: "claude", displayName: "Claude Code" };
  }
  if (evidence.includes("claude.ai") || evidence.includes("anthropic") || evidence.includes("claude")) {
    return { clientType: "claude", displayName: "Claude" };
  }
  return { clientType: "other", displayName: "Other AI assistant" };
}

/** Builds the per-deployment OAuth configuration from the request's public origin. */
function oauthOptions(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler: authorizationHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [LIBRARY_READ_SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [LIBRARY_READ_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Later Gator bookmark library",
    },
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
  };
}

/** Returns the provider helpers for an authenticated dashboard request. */
function oauthHelpers(env: Env, origin: string): OAuthHelpers {
  return getOAuthApi(oauthOptions(origin), env);
}

/** Extracts the form field as a bounded string. */
function formString(form: FormData, name: string, maximum = 16_384): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.length <= maximum ? value : null;
}

/** Redirects a validated OAuth denial back to the client without leaking local state. */
function denyAuthorization(request: AuthRequest): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The Later Gator owner declined access.");
  redirect.searchParams.set("state", request.state);
  if (request.issuer !== undefined) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

/** Rejects explicit foreign origins while allowing browsers that omit or opaque the form Origin. */
function oauthFormOriginMatches(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === "null" || originMatches(request);
}

/** Extracts the provider's opaque grant ID without rereading eventually consistent KV. */
function grantIdFromAuthorizationRedirect(redirectTo: string): string {
  const code = new URL(redirectTo).searchParams.get("code");
  const parts = code?.split(":") ?? [];
  const grantId = parts[1];
  if (
    parts.length !== 3 || parts[0] !== OWNER_ID || grantId === undefined ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(grantId) ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(parts[2] ?? "")
  ) {
    throw new Error("oauth_authorization_code_shape_invalid");
  }
  return grantId;
}

/** Records a completed OAuth grant so Settings can manage each connected assistant. */
async function recordConnection(
  db: D1Database,
  client: ClientInfo,
  metadata: ConnectionMetadata,
  grantId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mcp_connections (
        id, oauth_grant_id, client_id_hash, client_type, display_name, scope,
        connected_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      metadata.connectionId,
      grantId,
      await sha256Base64(client.clientId),
      metadata.clientType,
      metadata.displayName,
      LIBRARY_READ_SCOPE,
      metadata.connectedAt,
    )
    .run();
}

/** Replaces older grants for the same registered MCP client after a new grant succeeds. */
async function revokePriorClientConnections(
  db: D1Database,
  helpers: OAuthHelpers,
  client: ClientInfo,
  currentConnectionId: string,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT id, oauth_grant_id
         FROM mcp_connections
        WHERE client_id_hash = ? AND id <> ? AND revoked_at IS NULL`,
    )
    .bind(await sha256Base64(client.clientId), currentConnectionId)
    .all<{ id: string; oauth_grant_id: string }>();
  for (const row of rows.results) {
    try {
      await helpers.revokeGrant(row.oauth_grant_id, OWNER_ID);
      await db
        .prepare("UPDATE mcp_connections SET revoked_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), row.id)
        .run();
    } catch {
      console.error(JSON.stringify({
        event: "mcp_prior_connection_revocation_failed",
        safeCode: "oauth_grant_revocation_failed",
      }));
    }
  }
}

/** Completes an approved OAuth request and creates its dashboard connection record. */
async function approveAuthorization(
  request: AuthRequest,
  client: ClientInfo,
  env: Env,
  helpers: OAuthHelpers,
): Promise<Response> {
  if (!request.scope.includes(LIBRARY_READ_SCOPE)) {
    return oauthErrorPage("This AI assistant did not request read-only library access.");
  }
  const described = describeClient(client, request);
  const metadata: ConnectionMetadata = {
    connectionId: crypto.randomUUID(),
    clientType: described.clientType,
    displayName: described.displayName,
    connectedAt: new Date().toISOString(),
  };
  const { redirectTo } = await helpers.completeAuthorization({
    request,
    userId: OWNER_ID,
    metadata,
    scope: [LIBRARY_READ_SCOPE],
    props: {
      connectionId: metadata.connectionId,
      permissions: [LIBRARY_READ_SCOPE],
    } satisfies McpAuthorizationProps,
  });
  const grantId = grantIdFromAuthorizationRedirect(redirectTo);
  try {
    await recordConnection(env.DB, client, metadata, grantId);
  } catch (error) {
    await helpers.revokeGrant(grantId, OWNER_ID);
    throw error;
  }
  await revokePriorClientConnections(env.DB, helpers, client, metadata.connectionId);
  return Response.redirect(redirectTo, 302);
}

/** Parses and validates one OAuth authorization request with a safe local error page. */
async function parseAuthorization(
  request: Request,
  helpers: OAuthHelpers,
): Promise<{ request: AuthRequest; client: ClientInfo } | Response> {
  try {
    const parsed = await helpers.parseAuthRequest(request);
    const client = await helpers.lookupClient(parsed.clientId);
    if (client === null) return oauthErrorPage("That AI assistant could not be verified.");
    return { request: parsed, client };
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthErrorPage(error.description);
    return oauthErrorPage("This connection request is invalid or has expired.");
  }
}

/** Renders the authorization page for an OAuth GET request. */
async function showAuthorization(
  request: Request,
  env: Env,
  helpers: OAuthHelpers,
): Promise<Response> {
  const parsed = await parseAuthorization(request, helpers);
  if (parsed instanceof Response) return parsed;
  const session = await loadSession(request, env.DB);
  if (session === null) {
    return beginAuthorizationContinuation(parsed.request, env, new URL(request.url).origin);
  }
  let csrfToken = readCookie(request, "lg_csrf");
  let refreshedCsrfCookie: string | null = null;
  if (csrfToken === null || !(await requireCsrfValue(env.DB, session, csrfToken))) {
    const refreshed = await refreshSessionCsrf(env.DB, session);
    csrfToken = refreshed.csrfToken;
    refreshedCsrfCookie = refreshed.cookie;
  }
  const described = describeClient(parsed.client, parsed.request);
  const page = oauthConsentPage({
    clientName: described.displayName,
    redirectUri: parsed.request.redirectUri,
    serializedRequest: serializeAuthRequest(parsed.request),
    csrfToken,
    error: null,
    theme: themeFromCookie(request),
  });
  if (refreshedCsrfCookie === null) return page;
  const headers = new Headers(page.headers);
  headers.append("set-cookie", refreshedCsrfCookie);
  headers.set("cache-control", "no-store");
  return new Response(page.body, { status: page.status, headers });
}

/** Consumes the login continuation and returns the owner to the provider-validated request. */
async function resumeAuthorization(request: Request, env: Env): Promise<Response> {
  if (await loadSession(request, env.DB) === null) {
    return Response.redirect(new URL("/auth/login", request.url), 302);
  }
  const token = readCookie(request, MCP_LOGIN_RESUME_COOKIE);
  let stored: string | null = null;
  if (token !== null && /^[A-Za-z0-9_-]{40,64}$/u.test(token)) {
    const key = await authorizationContinuationKey(token);
    stored = await env.OAUTH_KV.get(key);
    await env.OAUTH_KV.delete(key);
  }
  let authRequest: AuthRequest | null = null;
  if (stored !== null) {
    try {
      const parsed = authorizationContinuationSchema.safeParse(JSON.parse(stored) as unknown);
      authRequest = parsed.success ? deserializeAuthRequest(parsed.data.oauthRequest) : null;
    } catch {
      authRequest = null;
    }
  }
  const result = authRequest === null
    ? oauthErrorPage("This connection request expired. Run the MCP login command again.")
    : Response.redirect(
      authorizationRequestFromSerialized(authRequest, new URL(request.url).origin).url,
      302,
    );
  const headers = new Headers(result.headers);
  headers.append("set-cookie", expiredAuthorizationContinuationCookie());
  headers.set("cache-control", "no-store");
  return new Response(result.body, { status: result.status, headers });
}

/** Validates and completes the owner's submitted OAuth consent decision. */
async function submitAuthorization(
  request: Request,
  env: Env,
  helpers: OAuthHelpers,
): Promise<Response> {
  if (!oauthFormOriginMatches(request)) {
    console.error(JSON.stringify({
      event: "mcp_authorization_rejected",
      safeCode: "oauth_origin_rejected",
    }));
    return oauthErrorPage("The browser could not verify this approval. Return to the terminal and run MCP login again.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 24 * 1024) {
    return oauthErrorPage("This connection request is too large.");
  }
  const form = await request.formData();
  const serialized = formString(form, "oauth_request");
  const echoed = serialized === null ? null : deserializeAuthRequest(serialized);
  if (echoed === null) return oauthErrorPage("This connection request is invalid or has expired.");
  const reparsed = await parseAuthorization(
    authorizationRequestFromSerialized(echoed, new URL(request.url).origin),
    helpers,
  );
  if (reparsed instanceof Response) return reparsed;
  if (formString(form, "decision", 16) === "deny") return denyAuthorization(reparsed.request);

  const session = await loadSession(request, env.DB);
  if (session === null) {
    return oauthErrorPage("Sign in to Later Gator, then restart this connection request.");
  }
  const csrfToken = formString(form, "csrf_token", 256);
  if (csrfToken === null || !(await requireCsrfValue(env.DB, session, csrfToken))) {
    console.error(JSON.stringify({
      event: "mcp_authorization_rejected",
      safeCode: "oauth_csrf_rejected",
    }));
    return oauthErrorPage("This approval expired. Return to the terminal and run MCP login again.");
  }

  return approveAuthorization(reparsed.request, reparsed.client, env, helpers);
}

/** Routes the authorization UI while the provider owns discovery and token endpoints. */
const authorizationHandler: ExportedHandler<Env> = {
  /** Serves only the owner-facing OAuth authorization endpoint. */
  fetch(request, env) {
    const helpers = oauthHelpers(env, new URL(request.url).origin);
    if (request.method === "GET" && new URL(request.url).pathname === "/authorize") {
      return showAuthorization(request, env, helpers);
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/authorize") {
      return submitAuthorization(request, env, helpers);
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/authorize/resume") {
      return resumeAuthorization(request, env);
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  },
};

/** Routes MCP, discovery, registration, authorization, and token requests through OAuth. */
export function handleMcpOAuthRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const provider = new OAuthProvider(oauthOptions(new URL(request.url).origin));
  return provider.fetch(request, env, context);
}

/** Updates a connected assistant's last-used timestamp without storing request content. */
async function markMcpConnectionUsed(db: D1Database, connectionId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await db
    .prepare(
      `UPDATE mcp_connections
          SET last_used_at = ?
        WHERE id = ? AND revoked_at IS NULL
          AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(new Date().toISOString(), connectionId, cutoff)
    .run();
}

/** Lists active OAuth grants as owner-facing AI connection summaries. */
export async function listMcpConnections(
  env: Env,
  origin: string,
): Promise<McpConnectionSummary[]> {
  const grantIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await oauthHelpers(env, origin).listUserGrants(OWNER_ID, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const grant of page.items) grantIds.add(grant.id);
    cursor = page.cursor;
  } while (cursor !== undefined);

  const rows = await env.DB
    .prepare(
      `SELECT id, oauth_grant_id, client_type, display_name, scope,
              connected_at, last_used_at
         FROM mcp_connections
        WHERE revoked_at IS NULL
        ORDER BY connected_at DESC`,
    )
    .all<{
      id: string;
      oauth_grant_id: string;
      client_type: McpConnectionSummary["clientType"];
      display_name: string;
      scope: "library:read";
      connected_at: string;
      last_used_at: string | null;
    }>();
  const visibilityCutoff = new Date(Date.now() - MCP_GRANT_VISIBILITY_GRACE_MS).toISOString();
  const missing = rows.results.filter((row) =>
    !grantIds.has(row.oauth_grant_id) && row.connected_at < visibilityCutoff
  );
  if (missing.length > 0) {
    const now = new Date().toISOString();
    await env.DB.batch(missing.map((row) =>
      env.DB.prepare("UPDATE mcp_connections SET revoked_at = ? WHERE id = ?")
        .bind(now, row.id)
    ));
  }
  return rows.results
    .filter((row) => grantIds.has(row.oauth_grant_id) || row.connected_at >= visibilityCutoff)
    .map((row) => ({
      id: row.id,
      clientType: row.client_type,
      displayName: row.display_name,
      scope: row.scope,
      connectedAt: row.connected_at,
      lastUsedAt: row.last_used_at,
    }));
}

/** Revokes one OAuth grant owned by this Later Gator deployment. */
export async function revokeMcpConnection(
  env: Env,
  origin: string,
  connectionId: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare(
      "SELECT oauth_grant_id FROM mcp_connections WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(connectionId)
    .first<{ oauth_grant_id: string }>();
  if (row === null) return false;
  await oauthHelpers(env, origin).revokeGrant(row.oauth_grant_id, OWNER_ID);
  await env.DB
    .prepare("UPDATE mcp_connections SET revoked_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), connectionId)
    .run();
  return true;
}

/** Revokes every owner OAuth grant during a complete application reset. */
export async function revokeAllMcpConnections(env: Env, origin: string): Promise<void> {
  if (!("OAUTH_KV" in env)) return;
  const helpers = oauthHelpers(env, origin);
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(OWNER_ID, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    await Promise.all(page.items.map((grant: GrantSummary) => helpers.revokeGrant(grant.id, OWNER_ID)));
    cursor = page.cursor;
  } while (cursor !== undefined);
}
