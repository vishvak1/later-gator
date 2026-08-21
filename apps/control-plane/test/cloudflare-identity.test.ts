import { describe, expect, it } from "vitest";
import {
  buildCloudflareAuthorizationUrl,
  discoverCloudflareIdentity,
  fetchCloudflareUserId,
  type CloudflareDiscovery,
  type Fetcher,
} from "../src/adapters/cloudflare-identity";
import type { ControlConfig } from "../src/domain/config";

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

  it("requests only User Details Read and includes state plus S256 PKCE", () => {
    const url = buildCloudflareAuthorizationUrl(
      discovery,
      config,
      "state-value",
      "challenge-value",
    );
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.searchParams.get("scope")).toBe("user-details.read");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.has("nonce")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.search).not.toContain("Workers Scripts");
    expect(url.search).not.toContain("D1");
    expect(url.search).not.toContain("R2");
  });

  it("extracts only the stable user ID from a bounded Cloudflare API response", async () => {
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
            email: "must-not-be-returned@example.test",
            organizations: [{ id: "must-not-be-retained" }],
          },
        }),
      );
    };

    await expect(fetchCloudflareUserId("temporary-access-token", fetcher)).resolves.toBe(
      "stable-cloudflare-user-id",
    );
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
      fetchCloudflareUserId("temporary-access-token", redirectFetcher),
    ).rejects.toMatchObject({ code: "identity_callback_rejected" });
  });
});
