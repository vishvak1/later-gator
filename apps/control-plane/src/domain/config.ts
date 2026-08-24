import { z } from "zod";
import { ControlPlaneError } from "./errors";
import type { ControlFailureStage } from "./errors";

const controlConfigSchema = z
  .object({
    ENVIRONMENT: z.enum(["development", "production", "test"]),
    PUBLIC_ORIGIN: z.url(),
    CLOUDFLARE_OIDC_ISSUER: z.url(),
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: z.url(),
    CLOUDFLARE_ACCESS_AUD: z.string().min(16).max(256),
    CONTROL_SESSION_TTL_SECONDS: z.coerce.number().int().min(900).max(604_800),
    CLOUDFLARE_IDENTITY_CLIENT_ID: z.string().min(1).max(512),
    CLOUDFLARE_IDENTITY_CLIENT_SECRET: z.string().min(1).max(4096),
    INSTALLER_TOKEN_ENCRYPTION_KEY: z.string().min(40).max(128),
    CHROME_EXTENSION_IDS: z.string().max(1024).optional(),
  })
  .strict();

export interface ControlConfig {
  environment: "development" | "production" | "test";
  publicOrigin: string;
  oidcIssuer: string;
  accessTeamDomain: string;
  accessAudience: string;
  sessionTtlSeconds: number;
  installerClientId: string;
  installerClientSecret: string;
  installerTokenEncryptionKey: string;
  chromeExtensionIds: string[];
}

/** Maps one invalid binding name to a bounded, value-free diagnostic stage. */
function configurationFailureStage(path: PropertyKey | undefined): ControlFailureStage {
  return ({
    ENVIRONMENT: "control_environment_invalid",
    PUBLIC_ORIGIN: "control_public_origin_invalid",
    CLOUDFLARE_OIDC_ISSUER: "control_oidc_issuer_invalid",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "control_access_team_domain_invalid",
    CLOUDFLARE_ACCESS_AUD: "control_access_audience_invalid",
    CONTROL_SESSION_TTL_SECONDS: "control_session_ttl_invalid",
    CLOUDFLARE_IDENTITY_CLIENT_ID: "control_identity_client_id_invalid",
    CLOUDFLARE_IDENTITY_CLIENT_SECRET: "control_identity_client_secret_invalid",
    INSTALLER_TOKEN_ENCRYPTION_KEY: "control_installer_key_invalid",
  } as const)[String(path)] ?? "control_environment_invalid";
}

/** Validates deploy-time bindings before they are used by authentication code. */
export function readControlConfig(env: Env): ControlConfig {
  const parsed = controlConfigSchema.safeParse({
    ENVIRONMENT: env.ENVIRONMENT,
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
    CLOUDFLARE_OIDC_ISSUER: env.CLOUDFLARE_OIDC_ISSUER,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
    CLOUDFLARE_ACCESS_AUD: env.CLOUDFLARE_ACCESS_AUD,
    CONTROL_SESSION_TTL_SECONDS: env.CONTROL_SESSION_TTL_SECONDS,
    CLOUDFLARE_IDENTITY_CLIENT_ID: env.CLOUDFLARE_IDENTITY_CLIENT_ID,
    CLOUDFLARE_IDENTITY_CLIENT_SECRET: env.CLOUDFLARE_IDENTITY_CLIENT_SECRET,
    INSTALLER_TOKEN_ENCRYPTION_KEY: env.INSTALLER_TOKEN_ENCRYPTION_KEY,
    CHROME_EXTENSION_IDS: env.CHROME_EXTENSION_IDS,
  });
  if (!parsed.success) {
    throw new ControlPlaneError(
      "identity_provider_unavailable",
      503,
      configurationFailureStage(parsed.error.issues[0]?.path[0]),
    );
  }
  const publicOrigin = new URL(parsed.data.PUBLIC_ORIGIN);
  const oidcIssuer = new URL(parsed.data.CLOUDFLARE_OIDC_ISSUER);
  const accessTeamDomain = new URL(parsed.data.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  if (publicOrigin.pathname !== "/" || publicOrigin.search !== "" || publicOrigin.hash !== "") {
    throw new ControlPlaneError("identity_provider_unavailable", 503, "control_public_origin_invalid");
  }
  if (oidcIssuer.protocol !== "https:" || oidcIssuer.pathname !== "/") {
    throw new ControlPlaneError("identity_provider_unavailable", 503, "control_oidc_issuer_invalid");
  }
  if (
    accessTeamDomain.protocol !== "https:" ||
    accessTeamDomain.pathname !== "/" ||
    !accessTeamDomain.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new ControlPlaneError(
      "identity_provider_unavailable",
      503,
      "control_access_team_domain_invalid",
    );
  }
  return {
    environment: parsed.data.ENVIRONMENT,
    publicOrigin: publicOrigin.origin,
    oidcIssuer: oidcIssuer.origin,
    accessTeamDomain: accessTeamDomain.origin,
    accessAudience: parsed.data.CLOUDFLARE_ACCESS_AUD,
    sessionTtlSeconds: parsed.data.CONTROL_SESSION_TTL_SECONDS,
    installerClientId: parsed.data.CLOUDFLARE_IDENTITY_CLIENT_ID,
    installerClientSecret: parsed.data.CLOUDFLARE_IDENTITY_CLIENT_SECRET,
    installerTokenEncryptionKey: parsed.data.INSTALLER_TOKEN_ENCRYPTION_KEY,
    chromeExtensionIds: (parsed.data.CHROME_EXTENSION_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^[a-p]{32}$/u.test(value)),
  };
}
