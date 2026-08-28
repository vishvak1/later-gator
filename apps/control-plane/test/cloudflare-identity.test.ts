import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticateCloudflareAccess } from "../src/adapters/cloudflare-access";
import {
  discoverCloudflareIdentity,
  fetchCloudflareUserDetails,
  type CloudflareDiscovery,
  type Fetcher,
} from "../src/adapters/cloudflare-identity";
import type { ControlConfig } from "../src/domain/config";

const config: ControlConfig = {
  chromeExtensionIds: [],
  environment: "test",
  publicOrigin: "https://latergator.test",
  oidcIssuer: "https://dash.cloudflare.com",
  accessTeamDomain: "https://later-gator-test.cloudflareaccess.com",
  accessAudience: "a".repeat(64),
  sessionTtlSeconds: 43_200,
  installerClientId: "test-identity-client",
  installerClientSecret: "test-identity-secret",
  installerTokenEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const discovery: CloudflareDiscovery = {
  issuer: "https://dash.cloudflare.com",
  authorization_endpoint: "https://dash.cloudflare.com/oauth2/auth",
  token_endpoint: "https://dash.cloudflare.com/oauth2/token",
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
};

describe("Cloudflare identity adapter", () => {
  it("pins discovery endpoints to the configured Cloudflare issuer", async () => {
    let redirectMode: RequestRedirect | undefined;
    const fetcher: Fetcher = (_input, init) => {
      redirectMode = init?.redirect;
      return Promise.resolve(Response.json(discovery));
    };
    await expect(discoverCloudflareIdentity(config, fetcher)).resolves.toEqual(discovery);
    expect(redirectMode).toBe("manual");

    const changed = { ...discovery, token_endpoint: "https://attacker.test/token" };
    const changedFetcher: Fetcher = () => Promise.resolve(Response.json(changed));
    await expect(discoverCloudflareIdentity(config, changedFetcher)).rejects.toMatchObject({
      code: "identity_provider_unavailable",
    });

    const redirectFetcher: Fetcher = () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.test/discovery" },
        }),
      );
    await expect(discoverCloudflareIdentity(config, redirectFetcher)).rejects.toMatchObject({
      code: "identity_provider_unavailable",
    });
  });

  it("retries one transient discovery failure before validating the response", async () => {
    let calls = 0;
    const fetcher: Fetcher = () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? new Response(null, { status: 503 })
        : Response.json(discovery));
    };
    await expect(discoverCloudflareIdentity(config, fetcher)).resolves.toEqual(discovery);
    expect(calls).toBe(2);
  });

  it("extracts only the installer identity from a bounded Cloudflare API response", async () => {
    let requestUrl = "";
    let authorization = "";
    let redirectMode: RequestRedirect | undefined;
    const fetcher: Fetcher = (input, init) => {
      requestUrl = new Request(input).url;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      redirectMode = init?.redirect;
      return Promise.resolve(
        Response.json({
          success: true,
          result: {
            id: "stable-cloudflare-user-id",
            email: "Owner@Example.test",
            organizations: [{ id: "must-not-be-retained" }],
          },
        }),
      );
    };

    await expect(fetchCloudflareUserDetails("temporary-access-token", fetcher)).resolves.toEqual({
      id: "stable-cloudflare-user-id",
      email: "owner@example.test",
    });
    expect(requestUrl).toBe("https://api.cloudflare.com/client/v4/user");
    expect(authorization).toBe("Bearer temporary-access-token");
    expect(redirectMode).toBe("manual");

    const redirectFetcher: Fetcher = () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.test/user" },
        }),
      );
    await expect(
      fetchCloudflareUserDetails("temporary-access-token", redirectFetcher),
    ).rejects.toMatchObject({ code: "installer_callback_rejected" });
  });

  it("accepts only a signed Access application token for the configured audience", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const publicKey = await exportJWK(keys.publicKey);
    Object.assign(publicKey, { alg: "RS256", kid: "access-key", use: "sig" });
    const assertion = await new SignJWT({
      email: "Owner@Example.test",
      sub: "7335d417-61da-459d-899c-0a01c76a2f94",
      type: "app",
    })
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .setIssuer(config.accessTeamDomain)
      .setAudience(config.accessAudience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    const fetcher: Fetcher = (input) => {
      expect(new Request(input).url).toBe(
        "https://later-gator-test.cloudflareaccess.com/cdn-cgi/access/certs",
      );
      return Promise.resolve(Response.json({ keys: [publicKey] }));
    };
    const request = new Request("https://latergator.test/auth/access", {
      headers: { "cf-access-jwt-assertion": assertion },
    });
    await expect(authenticateCloudflareAccess(request, config, fetcher)).resolves.toEqual({
      email: "owner@example.test",
      subject: "7335d417-61da-459d-899c-0a01c76a2f94",
    });

    const forged = new Request(request, { headers: { "cf-access-jwt-assertion": `${assertion}x` } });
    await expect(authenticateCloudflareAccess(forged, config, fetcher)).rejects.toMatchObject({
      code: "identity_token_invalid",
    });
  });
});
