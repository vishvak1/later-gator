import { describe, expect, it } from "vitest";
import { readControlConfig } from "../src/domain/config";

/** Builds one fully valid generated-binding shape for configuration tests. */
function validEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PUBLIC_ORIGIN: "https://latergator.test",
    CLOUDFLARE_OIDC_ISSUER: "https://dash.cloudflare.com",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://later-gator-test.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUD: "a".repeat(64),
    CONTROL_SESSION_TTL_SECONDS: "43200",
    CLOUDFLARE_IDENTITY_CLIENT_ID: "client-id",
    CLOUDFLARE_IDENTITY_CLIENT_SECRET: "client-secret",
    INSTALLER_TOKEN_ENCRYPTION_KEY: "A".repeat(44),
    CHROME_EXTENSION_IDS: "",
  } as unknown as Env;
}

describe("control-plane configuration diagnostics", () => {
  it("reports only the bounded binding name when a secret is absent", () => {
    const input = validEnv();
    Object.assign(input, { CLOUDFLARE_IDENTITY_CLIENT_SECRET: undefined });
    expect(() => readControlConfig(input)).toThrow(expect.objectContaining({
      code: "identity_provider_unavailable",
      failureStage: "control_identity_client_secret_invalid",
    }));
  });

  it("accepts the exact development binding shape without exposing values", () => {
    expect(readControlConfig(validEnv())).toMatchObject({
      environment: "test",
      publicOrigin: "https://latergator.test",
      oidcIssuer: "https://dash.cloudflare.com",
    });
  });
});
