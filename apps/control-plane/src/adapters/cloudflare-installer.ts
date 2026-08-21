import { z } from "zod";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { readBoundedJson } from "./bounded-json";
import type { CloudflareDiscovery, Fetcher } from "./cloudflare-identity";

const NO_FOLLOW_REDIRECTS: RequestRedirect = "manual";
const CLOUDFLARE_ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts";

const installerTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(32_768),
  refresh_token: z.string().min(1).max(32_768),
  token_type: z.string().min(1).max(64),
  expires_in: z.coerce.number().int().min(60).max(31_536_000),
  scope: z.string().min(1).max(4096),
});

const accountsResponseSchema = z.object({
  success: z.literal(true),
  result: z.array(z.object({
    id: z.string().length(32).regex(/^[a-f0-9]+$/u),
  }).loose()).min(1).max(50),
}).loose();

export interface InstallerTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  grantedScopes: string[];
}

/** Builds a separate least-privilege installer consent request on the confidential client. */
export function buildCloudflareInstallerAuthorizationUrl(
  discovery: CloudflareDiscovery,
  config: ControlConfig,
  state: string,
  codeChallenge: string,
  requestedScopes: string[],
): URL {
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.identityClientId,
    redirect_uri: `${config.publicOrigin}/install/cloudflare/callback`,
    response_type: "code",
    scope: requestedScopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

/** Exchanges an installer code for access and renewable refresh credentials. */
export async function exchangeCloudflareInstallerCode(
  discovery: CloudflareDiscovery,
  config: ControlConfig,
  code: string,
  codeVerifier: string,
  fetcher: Fetcher = fetch,
): Promise<InstallerTokenSet> {
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
        redirect_uri: `${config.publicOrigin}/install/cloudflare/callback`,
        client_id: config.identityClientId,
        client_secret: config.identityClientSecret,
        code_verifier: codeVerifier,
      }),
      redirect: NO_FOLLOW_REDIRECTS,
    });
  } catch {
    throw new ControlPlaneError("installer_provider_unavailable", 503);
  }
  if (!response.ok) throw new ControlPlaneError("installer_callback_rejected", 401);
  const parsed = installerTokenResponseSchema.safeParse(
    await readBoundedJson(response, 131_072),
  );
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new ControlPlaneError("installer_callback_rejected", 401);
  }
  const grantedScopes = [...new Set(parsed.data.scope.split(/\s+/u).filter(Boolean))].sort();
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
    grantedScopes,
  };
}

/** Rotates an expired access token using the renewable installer authorization. */
export async function refreshCloudflareInstallerToken(
  discovery: CloudflareDiscovery,
  config: ControlConfig,
  refreshToken: string,
  expectedScopes: string[],
  fetcher: Fetcher = fetch,
): Promise<InstallerTokenSet> {
  let response: Response;
  try {
    response = await fetcher(discovery.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.identityClientId,
        client_secret: config.identityClientSecret,
      }),
      redirect: NO_FOLLOW_REDIRECTS,
    });
  } catch {
    throw new ControlPlaneError("installer_provider_unavailable", 503);
  }
  if (!response.ok) throw new ControlPlaneError("installer_callback_rejected", 401);
  const parsed = installerTokenResponseSchema.safeParse(
    await readBoundedJson(response, 131_072),
  );
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new ControlPlaneError("installer_callback_rejected", 401);
  }
  const grantedScopes = [...new Set(parsed.data.scope.split(/\s+/u).filter(Boolean))].sort();
  if (!expectedScopes.every((scope) => grantedScopes.includes(scope))) {
    throw new ControlPlaneError("installer_scope_rejected", 403);
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
    grantedScopes,
  };
}

/** Resolves the single account selected in Cloudflare consent and discards account profiles. */
export async function fetchSingleAuthorizedAccountId(
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  let response: Response;
  try {
    const url = new URL(CLOUDFLARE_ACCOUNTS_URL);
    url.searchParams.set("per_page", "50");
    response = await fetcher(url, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      redirect: NO_FOLLOW_REDIRECTS,
    });
  } catch {
    throw new ControlPlaneError("installer_provider_unavailable", 503);
  }
  if (!response.ok) throw new ControlPlaneError("installer_callback_rejected", 401);
  const parsed = accountsResponseSchema.safeParse(await readBoundedJson(response, 262_144));
  if (!parsed.success || parsed.data.result.length !== 1) {
    throw new ControlPlaneError("installer_account_selection_invalid", 409);
  }
  const account = parsed.data.result[0];
  if (account === undefined) throw new ControlPlaneError("installer_account_selection_invalid", 409);
  return account.id;
}
