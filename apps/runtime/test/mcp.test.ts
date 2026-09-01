import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/security/sessions";

const ORIGIN = "https://later-gator.test";
const MCP_ENDPOINT = `${ORIGIN}/mcp`;
const DEFAULT_REDIRECT_URI = "https://chatgpt.com/connector/oauth/callback";

interface AuthenticatedClient {
  cookie: string;
  csrf: string;
}

interface RegisteredClient {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
}

interface ConnectionResponse {
  endpoint: string;
  connections: { id: string; displayName: string; scope: string }[];
}

/** Signs into the owner dashboard for OAuth consent and connection management. */
async function login(): Promise<AuthenticatedClient> {
  const session = await createSession(env.DB);
  return {
    cookie: `${session.cookie.split(";")[0] ?? ""}; lg_csrf=${session.csrfToken}`,
    csrf: session.csrfToken,
  };
}

/** Creates a public OAuth client using the same DCR shape as an MCP host. */
async function registerClient(
  clientName = "ChatGPT",
  redirectUri = DEFAULT_REDIRECT_URI,
): Promise<RegisteredClient> {
  const response = await exports.default.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<RegisteredClient>();
}

/** Produces an RFC 7636 S256 code challenge for a public OAuth client. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Builds the provider-validated authorization URL used by CLI and hosted MCP clients. */
async function authorizationUrl(
  registered: RegisteredClient,
  redirectUri = DEFAULT_REDIRECT_URI,
): Promise<URL> {
  const verifier = "later-gator-oauth-test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const authorization = new URL(`${ORIGIN}/authorize`);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", registered.client_id);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", "library:read");
  authorization.searchParams.set("state", "test-state");
  authorization.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("resource", MCP_ENDPOINT);
  return authorization;
}

/** Extracts a hidden value emitted by the same-origin OAuth consent form. */
function hiddenValue(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`<input[^>]+name="${escaped}"[^>]+value="([^"]*)"`, "u").exec(html);
  if (match?.[1] === undefined) throw new Error(`Missing hidden field: ${name}`);
  return match[1];
}

/** Completes owner consent and exchanges the one-time code for an access token. */
async function authorize(client: AuthenticatedClient, registered: RegisteredClient): Promise<string> {
  const verifier = "later-gator-oauth-test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const redirectUri = "https://chatgpt.com/connector/oauth/callback";
  const authorization = await authorizationUrl(registered);

  const consent = await exports.default.fetch(authorization, {
    headers: { cookie: client.cookie },
  });
  expect(consent.status, await consent.clone().text()).toBe(200);
  const html = await consent.text();
  expect(html).toContain("to Later Gator?");

  const decision = await exports.default.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: client.cookie,
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      oauth_request: hiddenValue(html, "oauth_request"),
      csrf_token: hiddenValue(html, "csrf_token"),
      decision: "approve",
    }).toString(),
  });
  expect(decision.status, await decision.clone().text()).toBe(302);
  const redirect = new URL(decision.headers.get("location") ?? "");
  expect(redirect.searchParams.get("state")).toBe("test-state");
  const code = redirect.searchParams.get("code");
  if (code === null) throw new Error("Authorization code was not returned");

  const exchanged = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: MCP_ENDPOINT,
    }).toString(),
  });
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  return (await exchanged.json<TokenResponse>()).access_token;
}

/** Sends one Streamable HTTP JSON-RPC request with OAuth bearer authorization. */
async function rpc(body: object, accessToken: string, sessionId?: string): Promise<Response> {
  return exports.default.fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(body),
  });
}

/** Parses either JSON or the one-event SSE shape emitted by Streamable HTTP. */
function parseRpcResponse(text: string): Record<string, unknown> {
  if (text.startsWith("{")) return JSON.parse(text) as Record<string, unknown>;
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (data === undefined) throw new Error(`Missing JSON-RPC data in response: ${text}`);
  return JSON.parse(data) as Record<string, unknown>;
}

describe("OAuth-protected MCP connector", () => {
  it("advertises OAuth and rejects MCP calls without a bearer token", async () => {
    const metadata = await exports.default.fetch(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(metadata.status, await metadata.clone().text()).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: MCP_ENDPOINT,
      authorization_servers: [ORIGIN],
      scopes_supported: ["library:read"],
    });

    const response = await exports.default.fetch(MCP_ENDPOINT, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("authorizes ChatGPT with PKCE, lists tools, and revokes only that connection", async () => {
    const owner = await login();
    const registered = await registerClient();
    const accessToken = await authorize(owner, registered);

    const initialized = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "later-gator-test", version: "1.0.0" },
      },
    }, accessToken);
    expect(initialized.status, await initialized.clone().text()).toBe(200);
    expect(parseRpcResponse(await initialized.text())).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "Later Gator", version: "1.0.0" } },
    });

    const tools = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      accessToken,
      initialized.headers.get("mcp-session-id") ?? undefined,
    );
    expect(tools.status, await tools.clone().text()).toBe(200);
    expect(parseRpcResponse(await tools.text())).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "get_context", annotations: { readOnlyHint: true } },
          { name: "search_bookmarks", annotations: { readOnlyHint: true } },
          { name: "get_bookmark", annotations: { readOnlyHint: true } },
          { name: "get_library_status", annotations: { readOnlyHint: true } },
        ],
      },
    });

    const listed = await exports.default.fetch(`${ORIGIN}/api/mcp/connections`, {
      headers: { cookie: owner.cookie },
    });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const connections = await listed.json<ConnectionResponse>();
    expect(connections).toMatchObject({
      endpoint: MCP_ENDPOINT,
      connections: [{ displayName: "ChatGPT", scope: "library:read" }],
    });

    const connection = connections.connections[0];
    if (connection === undefined) throw new Error("Connection was not recorded");
    const disconnected = await exports.default.fetch(
      `${ORIGIN}/api/mcp/connections/${connection.id}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "x-csrf-token": owner.csrf,
        },
      },
    );
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);

    const rejected = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, accessToken);
    expect(rejected.status).toBe(401);
  });

  it("survives browser logout with a private single-use login continuation", async () => {
    const registered = await registerClient();
    const started = await exports.default.fetch(await authorizationUrl(registered), {
      redirect: "manual",
    });
    expect(started.status).toBe(302);
    expect(new URL(started.headers.get("location") ?? "").pathname).toBe("/auth/login");
    const continuation = started.headers.get("set-cookie")?.split(";")[0];
    if (continuation === undefined) throw new Error("Missing MCP login continuation cookie");

    const owner = await login();
    const resumed = await exports.default.fetch(`${ORIGIN}/authorize/resume`, {
      redirect: "manual",
      headers: { cookie: `${owner.cookie}; ${continuation}` },
    });
    expect(resumed.status).toBe(302);
    const resumedLocation = new URL(resumed.headers.get("location") ?? "");
    expect(resumedLocation.pathname).toBe("/authorize");
    expect(resumedLocation.searchParams.get("client_id")).toBe(registered.client_id);
    expect(resumed.headers.get("set-cookie")).toContain("Max-Age=0");

    const consent = await exports.default.fetch(resumedLocation, {
      headers: { cookie: owner.cookie },
    });
    expect(consent.status, await consent.clone().text()).toBe(200);
    expect(await consent.text()).toContain("Connect ChatGPT to Later Gator?");

    const replayed = await exports.default.fetch(`${ORIGIN}/authorize/resume`, {
      redirect: "manual",
      headers: { cookie: `${owner.cookie}; ${continuation}` },
    });
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain("Run the MCP login command again");
  });

  it("repairs missing CSRF and accepts browsers with omitted or opaque Origin", async () => {
    const owner = await login();
    const registered = await registerClient("Codex");
    const sessionCookie = owner.cookie.split(";")[0] ?? "";
    const consent = await exports.default.fetch(await authorizationUrl(registered), {
      headers: { cookie: sessionCookie },
    });
    expect(consent.status, await consent.clone().text()).toBe(200);
    expect(consent.headers.get("set-cookie")).toContain("lg_csrf=");
    const html = await consent.text();
    const csrfToken = hiddenValue(html, "csrf_token");

    const approved = await exports.default.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        oauth_request: hiddenValue(html, "oauth_request"),
        csrf_token: csrfToken,
        decision: "approve",
      }).toString(),
    });
    expect(approved.status, await approved.clone().text()).toBe(302);

    const opaqueRegistered = await registerClient("Codex");
    const opaqueConsent = await exports.default.fetch(await authorizationUrl(opaqueRegistered), {
      headers: { cookie: sessionCookie },
    });
    expect(opaqueConsent.status, await opaqueConsent.clone().text()).toBe(200);
    const opaqueHtml = await opaqueConsent.text();
    const opaqueCsrfToken = hiddenValue(opaqueHtml, "csrf_token");
    const opaqueApproved = await exports.default.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: sessionCookie,
        origin: "null",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        oauth_request: hiddenValue(opaqueHtml, "oauth_request"),
        csrf_token: opaqueCsrfToken,
        decision: "approve",
      }).toString(),
    });
    expect(opaqueApproved.status, await opaqueApproved.clone().text()).toBe(302);

    const crossSite = await exports.default.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://attacker.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        oauth_request: hiddenValue(opaqueHtml, "oauth_request"),
        csrf_token: opaqueCsrfToken,
        decision: "approve",
      }).toString(),
    });
    expect(crossSite.status).toBe(400);
    expect(await crossSite.text()).toContain("browser could not verify this approval");

    const listed = await exports.default.fetch(`${ORIGIN}/api/mcp/connections`, {
      headers: { cookie: sessionCookie },
    });
    const connections = (await listed.json<ConnectionResponse>()).connections;
    expect(connections).toHaveLength(2);
    for (const connection of connections) {
      const disconnected = await exports.default.fetch(
        `${ORIGIN}/api/mcp/connections/${connection.id}`,
        {
          method: "DELETE",
          headers: {
            cookie: sessionCookie,
            origin: ORIGIN,
            "x-csrf-token": opaqueCsrfToken,
          },
        },
      );
      expect(disconnected.status, await disconnected.clone().text()).toBe(200);
    }
  });

  it("records authorization when KV grant listing is temporarily stale", async () => {
    const owner = await login();
    const registered = await registerClient("Codex");
    const originalList = env.OAUTH_KV.list.bind(env.OAUTH_KV);
    const listSpy = vi.spyOn(env.OAUTH_KV, "list").mockImplementation((options) => {
      if (options?.prefix === "grant:owner:") {
        return Promise.resolve({ keys: [], list_complete: true, cacheStatus: null });
      }
      return originalList(options);
    });
    let connection: ConnectionResponse["connections"][number] | undefined;
    try {
      await authorize(owner, registered);
      const listedWhileStale = await exports.default.fetch(`${ORIGIN}/api/mcp/connections`, {
        headers: { cookie: owner.cookie },
      });
      expect(listedWhileStale.status, await listedWhileStale.clone().text()).toBe(200);
      connection = (await listedWhileStale.json<ConnectionResponse>()).connections[0];
    } finally {
      listSpy.mockRestore();
    }
    if (connection === undefined) throw new Error("KV-stale authorization was not recorded");
    const listedAfterConvergence = await exports.default.fetch(`${ORIGIN}/api/mcp/connections`, {
      headers: { cookie: owner.cookie },
    });
    expect((await listedAfterConvergence.json<ConnectionResponse>()).connections)
      .toContainEqual(expect.objectContaining({ id: connection.id }));
    const disconnected = await exports.default.fetch(
      `${ORIGIN}/api/mcp/connections/${connection.id}`,
      {
        method: "DELETE",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "x-csrf-token": owner.csrf,
        },
      },
    );
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);
  });

  it("allows the exact validated Codex loopback callback through consent CSP", async () => {
    const owner = await login();
    const redirectUri = "http://127.0.0.1:45123/callback/codex-test";
    const registered = await registerClient("Codex", redirectUri);
    const consent = await exports.default.fetch(await authorizationUrl(registered, redirectUri), {
      headers: { cookie: owner.cookie },
    });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const policy = consent.headers.get("content-security-policy");
    expect(policy).toContain("form-action 'self' http://127.0.0.1:45123");
    expect(policy).not.toContain("http://127.0.0.1:*");
  });

  it("allows a provider-validated private-use callback scheme through consent CSP", async () => {
    const owner = await login();
    const redirectUri = "com.example.client:/oauth";
    const registered = await registerClient("Native MCP client", redirectUri);
    const consent = await exports.default.fetch(await authorizationUrl(registered, redirectUri), {
      headers: { cookie: owner.cookie },
    });
    expect(consent.status, await consent.clone().text()).toBe(200);
    expect(consent.headers.get("content-security-policy"))
      .toContain("form-action 'self' com.example.client:");
  });

  it("replaces an older grant when the same registered client logs in again", async () => {
    const owner = await login();
    const registered = await registerClient("Codex");
    const firstToken = await authorize(owner, registered);
    const secondToken = await authorize(owner, registered);

    const listed = await exports.default.fetch(`${ORIGIN}/api/mcp/connections`, {
      headers: { cookie: owner.cookie },
    });
    const connections = await listed.json<ConnectionResponse>();
    expect(connections.connections).toHaveLength(1);
    expect(connections.connections[0]?.displayName).toBe("Codex");
    expect((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, firstToken)).status)
      .toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" }, secondToken)).status)
      .not.toBe(401);
  });
});
