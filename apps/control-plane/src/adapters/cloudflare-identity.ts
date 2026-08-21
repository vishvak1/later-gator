import { z } from "zod";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { readBoundedJson } from "./bounded-json";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Workers currently throws for `redirect: "error"`; `manual` preserves the
// no-follow boundary because every caller below rejects non-success responses.
const NO_FOLLOW_REDIRECTS: RequestRedirect = "manual";
const CLOUDFLARE_IDENTITY_SCOPE = "user-details.read";
const CLOUDFLARE_USER_DETAILS_URL = "https://api.cloudflare.com/client/v4/user";
const DISCOVERY_ATTEMPTS = 2;

const discoverySchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  code_challenge_methods_supported: z.array(z.string()).max(20),
  token_endpoint_auth_methods_supported: z.array(z.string()).max(20),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(32_768),
  token_type: z.string().min(1).max(64),
});

const userDetailsResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  }),
});

export type CloudflareDiscovery = z.infer<typeof discoverySchema>;

/** Ensures discovery endpoints remain pinned to the configured Cloudflare issuer. */
function validateDiscoveryOrigin(discovery: CloudflareDiscovery, issuer: string): void {
  if (discovery.issuer !== issuer) {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
  for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint]) {
    if (new URL(endpoint).origin !== issuer) {
      throw new ControlPlaneError("identity_provider_unavailable", 503);
    }
  }
  if (
    !discovery.code_challenge_methods_supported.includes("S256") ||
    !discovery.token_endpoint_auth_methods_supported.includes("client_secret_post")
  ) {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
}

/** Retrieves and validates Cloudflare's current OAuth endpoint document. */
export async function discoverCloudflareIdentity(
  config: ControlConfig,
  fetcher: Fetcher = fetch,
): Promise<CloudflareDiscovery> {
  const discoveryUrl = new URL("/.well-known/openid-configuration", config.oidcIssuer);
  for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(discoveryUrl, {
        headers: { accept: "application/json" },
        redirect: NO_FOLLOW_REDIRECTS,
      });
    } catch {
      if (attempt + 1 < DISCOVERY_ATTEMPTS) continue;
      throw new ControlPlaneError("identity_provider_unavailable", 503);
    }
    if (!response.ok) {
      if (attempt + 1 < DISCOVERY_ATTEMPTS) continue;
      throw new ControlPlaneError("identity_provider_unavailable", 503);
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response, 65_536);
    } catch {
      if (attempt + 1 < DISCOVERY_ATTEMPTS) continue;
      throw new ControlPlaneError("identity_provider_unavailable", 503);
    }
    const parsed = discoverySchema.safeParse(payload);
    if (!parsed.success) {
      if (attempt + 1 < DISCOVERY_ATTEMPTS) continue;
      throw new ControlPlaneError("identity_provider_unavailable", 503);
    }
    validateDiscoveryOrigin(parsed.data, config.oidcIssuer);
    return parsed.data;
  }
  throw new ControlPlaneError("identity_provider_unavailable", 503);
}

/** Builds a least-privilege Cloudflare user-identity request with state and PKCE. */
export function buildCloudflareAuthorizationUrl(
  discovery: CloudflareDiscovery,
  config: ControlConfig,
  state: string,
  codeChallenge: string,
): URL {
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.identityClientId,
    redirect_uri: `${config.publicOrigin}/auth/cloudflare/callback`,
    response_type: "code",
    scope: CLOUDFLARE_IDENTITY_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

/** Exchanges an authorization code for a short-lived token that is never persisted. */
export async function exchangeCloudflareAuthorizationCode(
  discovery: CloudflareDiscovery,
  config: ControlConfig,
  code: string,
  codeVerifier: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(discovery.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${config.publicOrigin}/auth/cloudflare/callback`,
        client_id: config.identityClientId,
        client_secret: config.identityClientSecret,
        code_verifier: codeVerifier,
      }),
      redirect: NO_FOLLOW_REDIRECTS,
    });
  } catch {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
  if (!response.ok) throw new ControlPlaneError("identity_callback_rejected", 401);
  const parsed = tokenResponseSchema.safeParse(await readBoundedJson(response, 65_536));
  if (!parsed.success) throw new ControlPlaneError("identity_callback_rejected", 401);
  if (parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new ControlPlaneError("identity_callback_rejected", 401);
  }
  return parsed.data.access_token;
}

/** Retrieves only the stable Cloudflare user ID and discards all other details. */
export async function fetchCloudflareUserId(
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(CLOUDFLARE_USER_DETAILS_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      redirect: NO_FOLLOW_REDIRECTS,
    });
  } catch {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
  if (!response.ok) throw new ControlPlaneError("identity_callback_rejected", 401);
  const parsed = userDetailsResponseSchema.safeParse(await readBoundedJson(response, 131_072));
  if (!parsed.success) throw new ControlPlaneError("identity_callback_rejected", 401);
  return parsed.data.result.id;
}
