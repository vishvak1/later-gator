import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertOwner } from "../src/adapters/control-repository";
import {
  completeInstallerAuthorization,
  installerScopes,
  startInstallerAuthorization,
} from "../src/application/installer";
import type { ControlConfig } from "../src/domain/config";
import { sha256Base64Url } from "../src/security/encoding";
import {
  decryptInstallerToken,
  encryptInstallerToken,
} from "../src/security/installer-token-vault";

const ACCOUNT_ID = "a".repeat(32);
const CLOUDFLARE_USER_ID = "cloudflare-user-0001";
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const config: ControlConfig = {
  chromeExtensionIds: [],
  environment: "test",
  publicOrigin: "https://latergator.test",
  oidcIssuer: "https://dash.cloudflare.com",
  sessionTtlSeconds: 43_200,
  identityClientId: "test-identity-client",
  identityClientSecret: "test-identity-secret",
  installerTokenEncryptionKey: ENCRYPTION_KEY,
};

/** Returns bounded Cloudflare fixtures based only on the requested official endpoint. */
function cloudflareFetcher(grantedScopes: string[] = installerScopes("kv")) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/openid-configuration") {
      return Promise.resolve(Response.json({
        issuer: "https://dash.cloudflare.com",
        authorization_endpoint: "https://dash.cloudflare.com/oauth2/auth",
        token_endpoint: "https://dash.cloudflare.com/oauth2/token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      }));
    }
    if (url.pathname === "/oauth2/token") {
      return Promise.resolve(Response.json({
        access_token: "private-installer-access-token",
        refresh_token: "private-installer-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: grantedScopes.join(" "),
      }));
    }
    if (url.pathname === "/client/v4/user") {
      return Promise.resolve(Response.json({
        success: true,
        result: { id: CLOUDFLARE_USER_ID, email: "discard@example.test" },
      }));
    }
    if (url.pathname === "/client/v4/accounts") {
      return Promise.resolve(Response.json({
        success: true,
        result: [{ id: ACCOUNT_ID, name: "Discarded account name" }],
      }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

beforeEach(async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM provisioning_steps"),
    env.CONTROL_DB.prepare("DELETE FROM installations"),
    env.CONTROL_DB.prepare("DELETE FROM installer_authorizations"),
    env.CONTROL_DB.prepare("DELETE FROM oauth_installer_requests"),
    env.CONTROL_DB.prepare("DELETE FROM control_audit_events"),
    env.CONTROL_DB.prepare("DELETE FROM control_sessions"),
    env.CONTROL_DB.prepare("DELETE FROM oauth_login_requests"),
    env.CONTROL_DB.prepare("DELETE FROM owners"),
  ]);
});

describe("purpose-specific installer authorization", () => {
  it("requests only the KV subset and stores renewable credentials only as ciphertext", async () => {
    const ownerId = await upsertOwner(
      env.CONTROL_DB,
      await sha256Base64Url(`cloudflare-user\u0000${CLOUDFLARE_USER_ID}`),
      100,
    );
    const fetcher = cloudflareFetcher();
    const started = await startInstallerAuthorization(
      env.CONTROL_DB,
      config,
      ownerId,
      "kv",
      fetcher,
      100,
    );
    const authorizationUrl = new URL(started.location);
    expect(authorizationUrl.pathname).toBe("/oauth2/auth");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://latergator.test/install/cloudflare/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")?.split(" ").sort()).toEqual(
      installerScopes("kv"),
    );
    expect(authorizationUrl.searchParams.get("scope")).not.toContain("workers-r2.write");

    const completed = await completeInstallerAuthorization(
      env.CONTROL_DB,
      config,
      {
        code: "authorization-code-0001",
        state: started.state,
        cookieState: started.state,
        ownerId,
      },
      fetcher,
      200,
    );
    expect(completed).toMatchObject({ accountId: ACCOUNT_ID, storageMode: "kv" });
    const authorization = await env.CONTROL_DB
      .prepare(
        `SELECT account_id, token_ciphertext, token_nonce, schema_version,
                granted_scopes_json, token_expires_at
           FROM installer_authorizations WHERE owner_id = ?`,
      )
      .bind(ownerId)
      .first();
    expect(authorization).toMatchObject({ account_id: ACCOUNT_ID, schema_version: 1 });
    expect(JSON.stringify(authorization)).not.toContain("private-installer-access-token");
    expect(JSON.stringify(authorization)).not.toContain("private-installer-refresh-token");
    expect(await env.CONTROL_DB.prepare(
      "SELECT storage_mode, status, current_step FROM installations WHERE owner_id = ?",
    ).bind(ownerId).first()).toEqual({
      storage_mode: "kv",
      status: "authorized",
      current_step: "d1",
    });

    await expect(completeInstallerAuthorization(
      env.CONTROL_DB,
      config,
      {
        code: "authorization-code-replay",
        state: started.state,
        cookieState: started.state,
        ownerId,
      },
      fetcher,
      201,
    )).rejects.toMatchObject({ code: "installer_callback_rejected" });
  });

  it("adds R2 permission only after the owner chooses R2", () => {
    expect(installerScopes("r2")).toContain("workers-r2.write");
    expect(installerScopes("kv")).not.toContain("workers-r2.write");
    expect(installerScopes("r2")).toContain("user-details.read");
    expect(installerScopes("r2")).toContain("offline_access");
  });

  it("rejects a token missing any immutable requested scope", async () => {
    const ownerId = await upsertOwner(
      env.CONTROL_DB,
      await sha256Base64Url(`cloudflare-user\u0000${CLOUDFLARE_USER_ID}`),
      100,
    );
    const startFetcher = cloudflareFetcher();
    const started = await startInstallerAuthorization(
      env.CONTROL_DB,
      config,
      ownerId,
      "kv",
      startFetcher,
      100,
    );
    await expect(completeInstallerAuthorization(
      env.CONTROL_DB,
      config,
      {
        code: "authorization-code-0002",
        state: started.state,
        cookieState: started.state,
        ownerId,
      },
      cloudflareFetcher(installerScopes("kv").filter((scope) => scope !== "d1.write")),
      200,
    )).rejects.toMatchObject({ code: "installer_scope_rejected" });
  });
});

describe("installer token vault", () => {
  it("round-trips a token and binds authenticated data to owner and account", async () => {
    const encrypted = await encryptInstallerToken(
      ENCRYPTION_KEY,
      "owner-0001",
      ACCOUNT_ID,
      {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresIn: 3600,
        grantedScopes: installerScopes("kv"),
      },
      100,
    );
    expect(encrypted.ciphertext).not.toContain("access-secret");
    await expect(decryptInstallerToken(
      ENCRYPTION_KEY,
      "different-owner",
      ACCOUNT_ID,
      encrypted,
    )).rejects.toBeInstanceOf(Error);
    expect(await decryptInstallerToken(
      ENCRYPTION_KEY,
      "owner-0001",
      ACCOUNT_ID,
      encrypted,
    )).toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret" });
  });
});
