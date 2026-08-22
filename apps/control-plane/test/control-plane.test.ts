import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeLoginRequest,
  storeAuditEvent,
  storeControlSession,
  storeLoginRequest,
  upsertOwner,
} from "../src/adapters/control-repository";
import { startIdentityLogin } from "../src/application/identity";
import type { ControlConfig } from "../src/domain/config";
import { constantTimeEqual, randomToken, sha256Base64Url } from "../src/security/encoding";
import { modelCatalogSchema, storagePlanCatalogSchema } from "@later-gator/contracts";
import { renderDashboard } from "../src/routes/pages";

describe("control-plane foundation", () => {
  beforeEach(async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("DELETE FROM control_audit_events"),
      env.CONTROL_DB.prepare("DELETE FROM control_sessions"),
      env.CONTROL_DB.prepare("DELETE FROM oauth_login_requests"),
      env.CONTROL_DB.prepare("DELETE FROM owners"),
    ]);
  });

  it("serves a control plane that states the personal-data boundary", async () => {
    const response = await exports.default.fetch("https://latergator.test/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Continue with Cloudflare");
    expect(html).toContain("bookmark content, thumbnails, AI settings, and provider keys");
    expect(html).toContain("personal Worker");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://dash.cloudflare.com",
    );
  });

  it("presents managed updates without an application-level opt-out", async () => {
    const html = renderDashboard("csrf-token", {
      status: "ready",
      storageMode: "kv",
      safeErrorCode: null,
      installedRelease: "1.0.0",
      desiredRelease: "1.0.0",
      updateStatus: "complete",
      workerOrigin: "https://later-gator-personal.example.workers.dev",
      authorizationActive: true,
    });
    expect(html).toContain("Automatic updates active");
    expect(html).not.toContain("Revoke update authorization");
    expect(html).not.toContain("/install/revoke");

    const removedRoute = await exports.default.fetch(new Request(
      "https://latergator.test/install/revoke",
      { method: "POST" },
    ));
    expect(removedRoute.status).toBe(404);
  });

  it("does not report managed updates as active before installation", () => {
    const html = renderDashboard("csrf-token", null);
    expect(html).toContain("Managed updates start after setup");
    expect(html).toContain("Connect Cloudflare and create your personal runtime");
    expect(html).not.toContain("Automatic updates active");
  });

  it("offers re-authorization after installer authorization becomes inactive", () => {
    const html = renderDashboard("csrf-token", {
      status: "ready",
      storageMode: "kv",
      safeErrorCode: null,
      installedRelease: "1.0.0",
      desiredRelease: "1.0.0",
      updateStatus: "failed",
      workerOrigin: "https://later-gator-personal.example.workers.dev",
      authorizationActive: false,
    });
    expect(html).toContain("Re-authorization needed");
    expect(html).toContain("Restore managed updates");
    expect(html).not.toContain("Automatic updates active");
  });

  it("exposes only safe service health metadata", async () => {
    const response = await exports.default.fetch("https://latergator.test/health");
    expect(await response.json()).toEqual({
      contractVersion: 1,
      service: "later-gator-control-plane",
      status: "ready",
    });
  });

  it("publishes rotated assertion keys without private signing material", async () => {
    const response = await exports.default.fetch(
      "https://latergator.test/.well-known/later-gator-jwks.json",
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ keys: Record<string, unknown>[] }>();
    expect(body.keys.map((key) => key.kid)).toEqual([
      "test-owner-key-previous",
      "test-owner-key-active",
    ]);
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it("publishes bounded signed catalogs without owner or credential fields", async () => {
    const [modelsResponse, plansResponse] = await Promise.all([
      exports.default.fetch("https://latergator.test/catalogs/models"),
      exports.default.fetch("https://latergator.test/catalogs/storage-plans"),
    ]);
    expect(modelsResponse.status).toBe(200);
    expect(plansResponse.status).toBe(200);
    const models = modelCatalogSchema.parse(await modelsResponse.json());
    const plans = storagePlanCatalogSchema.parse(await plansResponse.json());
    expect(models.signingKeyId).toBe("test-owner-key-active");
    expect(plans.signingKeyId).toBe("test-owner-key-active");
    expect(models.models.some((model) => model.provider === "openai")).toBe(true);
    expect(models.models.some((model) => model.provider === "anthropic")).toBe(true);
    expect(plans.reviewedOn).toBe("2026-08-21");
    const publicPayload = JSON.stringify({ models, plans });
    expect(publicPayload).not.toContain("ownerId");
    expect(publicPayload).not.toContain("credential");
    expect(publicPayload).not.toContain("installation");
  });

  it("creates strong tokens and stable opaque hashes", async () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
    expect(await sha256Base64Url("stable")).toBe(await sha256Base64Url("stable"));
    expect(constantTimeEqual(first, first)).toBe(true);
    expect(constantTimeEqual(first, second)).toBe(false);
  });

  it("consumes OAuth state once and rejects callback replay", async () => {
    const stateHash = await sha256Base64Url("test-state");
    await storeLoginRequest(env.CONTROL_DB, {
      stateHash,
      codeVerifier: "test-code-verifier",
      returnPath: "/",
      createdAt: 100,
      expiresAt: 700,
    });
    expect(await consumeLoginRequest(env.CONTROL_DB, stateHash, 200)).toEqual({
      codeVerifier: "test-code-verifier",
      returnPath: "/",
    });
    expect(await consumeLoginRequest(env.CONTROL_DB, stateHash, 201)).toBeNull();
  });

  it("keeps the complete control session across Cloudflare's top-level OAuth return", async () => {
    const discovery = {
      issuer: "https://dash.cloudflare.com",
      authorization_endpoint: "https://dash.cloudflare.com/oauth2/auth",
      token_endpoint: "https://dash.cloudflare.com/oauth2/token",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    };
    const providerFetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(new Request(input).url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Promise.resolve(Response.json(discovery));
      }
      if (url.pathname === "/oauth2/token") {
        return Promise.resolve(Response.json({
          access_token: "temporary-test-access-token",
          token_type: "Bearer",
        }));
      }
      if (url.href === "https://api.cloudflare.com/client/v4/user") {
        return Promise.resolve(Response.json({
          success: true,
          result: { id: "stable-test-cloudflare-user" },
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", providerFetch);

    try {
      const start = await exports.default.fetch(new Request(
        "https://latergator.test/auth/cloudflare",
        { redirect: "manual" },
      ));
      expect(start.status).toBe(302);
      const stateCookie = start.headers.get("set-cookie") ?? "";
      const state = /lg_cp_oauth_state=([^;]+)/u.exec(stateCookie)?.[1];
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      const callback = await exports.default.fetch(new Request(
        `https://latergator.test/auth/cloudflare/callback?code=authorization-code&state=${state ?? ""}`,
        {
          headers: { cookie: `lg_cp_oauth_state=${state ?? ""}` },
          redirect: "manual",
        },
      ));
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/");
      const callbackCookies = callback.headers.get("set-cookie") ?? "";
      expect(callbackCookies).toMatch(
        /lg_cp_session=[^;]+; Path=\/; Max-Age=43200; SameSite=Lax; HttpOnly; Secure/u,
      );
      expect(callbackCookies).toMatch(
        /lg_cp_csrf=[^;]+; Path=\/; Max-Age=43200; SameSite=Lax; Secure/u,
      );
      expect(callbackCookies).not.toMatch(/lg_cp_csrf=[^,]*SameSite=Strict/u);

      const sessionToken = /lg_cp_session=([^;]+)/u.exec(callbackCookies)?.[1];
      const csrfToken = /lg_cp_csrf=([^;]+)/u.exec(callbackCookies)?.[1];
      expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      const landing = await exports.default.fetch(new Request("https://latergator.test/", {
        headers: {
          cookie: `lg_cp_session=${sessionToken ?? ""}; lg_cp_csrf=${csrfToken ?? ""}`,
        },
      }));
      expect(landing.status).toBe(200);
      const html = await landing.text();
      expect(html).toContain("Your Later Gator");
      expect(html).not.toContain("Continue with Cloudflare");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates no tables for bookmarks, thumbnails, or provider credentials", async () => {
    const rows = await env.CONTROL_DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = rows.results.map((row) => row.name);
    expect(names).toContain("owners");
    expect(names).toContain("control_sessions");
    expect(names).not.toContain("bookmarks");
    expect(names).not.toContain("thumbnails");
    expect(names).not.toContain("provider_credentials");
  });

  it("deletes only authenticated control-plane identity metadata", async () => {
    const sessionToken = "s".repeat(43);
    const csrfToken = "c".repeat(43);
    const ownerId = await upsertOwner(env.CONTROL_DB, await sha256Base64Url("owner-subject"), 100);
    await storeControlSession(env.CONTROL_DB, {
      sessionHash: await sha256Base64Url(sessionToken),
      ownerId,
      csrfHash: await sha256Base64Url(csrfToken),
      createdAt: 100,
      expiresAt: 2_000_000_000,
    });
    await storeAuditEvent(env.CONTROL_DB, ownerId, "identity_login_succeeded", 100);

    const response = await exports.default.fetch(
      new Request("https://latergator.test/account/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `lg_cp_session=${sessionToken}; lg_cp_csrf=${csrfToken}`,
          origin: "https://latergator.test",
        },
        body: new URLSearchParams({
          confirmation: "delete-control-metadata",
          csrf: csrfToken,
        }),
        redirect: "manual",
      }),
    );
    expect(response.status).toBe(303);
    expect(await env.CONTROL_DB.prepare("SELECT id FROM owners WHERE id = ?").bind(ownerId).first()).toBeNull();
    expect(
      await env.CONTROL_DB.prepare("SELECT session_hash FROM control_sessions WHERE owner_id = ?")
        .bind(ownerId)
        .first(),
    ).toBeNull();
    expect(
      await env.CONTROL_DB.prepare("SELECT id FROM control_audit_events WHERE owner_id = ?")
        .bind(ownerId)
        .first(),
    ).toBeNull();
  });

  it("clears a stale CSRF cookie before rendering an actionable dashboard", async () => {
    const sessionToken = "s".repeat(43);
    const csrfToken = "c".repeat(43);
    const ownerId = await upsertOwner(
      env.CONTROL_DB,
      await sha256Base64Url(`stale-csrf-${crypto.randomUUID()}`),
      100,
    );
    await storeControlSession(env.CONTROL_DB, {
      sessionHash: await sha256Base64Url(sessionToken),
      ownerId,
      csrfHash: await sha256Base64Url(csrfToken),
      createdAt: 100,
      expiresAt: 2_000_000_000,
    });
    const response = await exports.default.fetch(new Request("https://latergator.test/", {
      headers: { cookie: `lg_cp_session=${sessionToken}; lg_cp_csrf=${"x".repeat(43)}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Continue with Cloudflare");
    expect(response.headers.get("set-cookie")).toContain("lg_cp_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("never copies provider callback details into logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const response = await exports.default.fetch(
        "https://latergator.test/auth/cloudflare/callback?error=private-token&error_description=private-url",
      );
      expect(response.status).toBe(401);
      const output = log.mock.calls.flat().join(" ");
      expect(output).toContain("identity_callback_rejected");
      expect(output).not.toContain("private-token");
      expect(output).not.toContain("private-url");
      expect(output).not.toContain("auth/cloudflare/callback");
    } finally {
      log.mockRestore();
    }
  });

  it("logs only a bounded stage when an authenticated form lacks its origin", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const response = await exports.default.fetch(new Request(
        "https://latergator.test/install/authorize",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf: "c".repeat(43), storage_mode: "kv" }),
        },
      ));
      expect(response.status).toBe(403);
      const output = log.mock.calls.flat().join(" ");
      expect(output).toContain("session_origin_invalid");
      expect(output).not.toContain("storage_mode");
      expect(output).not.toContain("install/authorize");
    } finally {
      log.mockRestore();
    }
  });

  it("accepts same-origin browser fetch metadata while retaining session-bound CSRF", async () => {
    const sessionToken = "s".repeat(43);
    const csrfToken = "c".repeat(43);
    const ownerId = await upsertOwner(
      env.CONTROL_DB,
      await sha256Base64Url(`fetch-metadata-${crypto.randomUUID()}`),
      100,
    );
    await storeControlSession(env.CONTROL_DB, {
      sessionHash: await sha256Base64Url(sessionToken),
      ownerId,
      csrfHash: await sha256Base64Url(csrfToken),
      createdAt: 100,
      expiresAt: 2_000_000_000,
    });
    const response = await exports.default.fetch(new Request(
      "https://latergator.test/auth/logout",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `lg_cp_session=${sessionToken}; lg_cp_csrf=${csrfToken}`,
          origin: "null",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ csrf: csrfToken }),
        redirect: "manual",
      },
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("classifies OAuth state-storage failures without retaining provider data", async () => {
    const config: ControlConfig = {
      chromeExtensionIds: [],
      environment: "test",
      publicOrigin: "https://latergator.test",
      oidcIssuer: "https://dash.cloudflare.com",
      sessionTtlSeconds: 43_200,
      identityClientId: "test-identity-client",
      identityClientSecret: "test-identity-secret",
      installerTokenEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const discovery = {
      issuer: "https://dash.cloudflare.com",
      authorization_endpoint: "https://dash.cloudflare.com/oauth2/auth",
      token_endpoint: "https://dash.cloudflare.com/oauth2/token",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    };
    const unavailableDatabase = {
      prepare: () => {
        throw new Error("private provider payload");
      },
    } as unknown as D1Database;

    await expect(
      startIdentityLogin(
        unavailableDatabase,
        config,
        () => Promise.resolve(Response.json(discovery)),
      ),
    ).rejects.toMatchObject({
      code: "identity_provider_unavailable",
      failureStage: "identity_state_storage_failed",
    });
  });
});
