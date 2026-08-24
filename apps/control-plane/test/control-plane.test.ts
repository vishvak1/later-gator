import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  storeAuditEvent,
  storeControlSession,
  upsertOwner,
} from "../src/adapters/control-repository";
import { constantTimeEqual, randomToken, sha256Base64Url } from "../src/security/encoding";
import { modelCatalogSchema, storagePlanCatalogSchema } from "@later-gator/contracts";
import { renderDashboard } from "../src/routes/pages";

describe("control-plane foundation", () => {
  beforeEach(async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("DELETE FROM control_audit_events"),
      env.CONTROL_DB.prepare("DELETE FROM control_sessions"),
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
      runtimeHealthStatus: "ready",
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
      runtimeHealthStatus: "ready",
      authorizationActive: false,
    });
    expect(html).toContain("Re-authorization needed");
    expect(html).toContain("Restore managed updates");
    expect(html).not.toContain("Automatic updates active");
  });

  it("disables the stale runtime link and offers repair after external deletion", () => {
    const html = renderDashboard("csrf-token", {
      status: "ready",
      storageMode: "kv",
      safeErrorCode: "runtime_worker_missing",
      installedRelease: "1.0.0",
      desiredRelease: "1.0.0",
      updateStatus: "idle",
      workerOrigin: "https://deleted.example.workers.dev",
      runtimeHealthStatus: "unavailable",
      authorizationActive: true,
    });
    expect(html).toContain("Your runtime Worker was deleted");
    expect(html).toContain("Recreate missing Worker");
    expect(html).not.toContain("href=\"https://deleted.example.workers.dev");
    expect(html).not.toContain("href=\"/runtime/open\"");
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

  it("creates a complete local session from a validated Cloudflare Access assertion", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const publicKey = await exportJWK(keys.publicKey);
    Object.assign(publicKey, { alg: "RS256", kid: "access-key", use: "sig" });
    const assertion = await new SignJWT({
      email: "owner@example.test",
      sub: "7335d417-61da-459d-899c-0a01c76a2f94",
      type: "app",
    })
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .setIssuer("https://later-gator-test.cloudflareaccess.com")
      .setAudience("a".repeat(64))
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ keys: [publicKey] }))));

    try {
      const callback = await exports.default.fetch(new Request(
        "https://latergator.test/auth/access",
        { headers: { "cf-access-jwt-assertion": assertion }, redirect: "manual" },
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

      const sessionToken = /lg_cp_session=([^;]+)/u.exec(callbackCookies)?.[1];
      const csrfToken = /lg_cp_csrf=([^;]+)/u.exec(callbackCookies)?.[1];
      const landing = await exports.default.fetch(new Request("https://latergator.test/", {
        headers: { cookie: `lg_cp_session=${sessionToken ?? ""}; lg_cp_csrf=${csrfToken ?? ""}` },
      }));
      expect(await landing.text()).toContain("Your Later Gator");
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

  it("never copies Access request details into logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const response = await exports.default.fetch(
        "https://latergator.test/auth/access?error=private-token&error_description=private-url",
      );
      expect(response.status).toBe(401);
      const output = log.mock.calls.flat().join(" ");
      expect(output).toContain("identity_token_invalid");
      expect(output).not.toContain("private-token");
      expect(output).not.toContain("private-url");
      expect(output).not.toContain("auth/access");
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

});
