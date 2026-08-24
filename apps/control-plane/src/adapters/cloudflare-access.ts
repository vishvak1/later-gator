import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import type { Fetcher } from "./cloudflare-identity";

const accessClaimsSchema = z.object({
  email: z.email().max(320),
  sub: z.uuid(),
  type: z.literal("app"),
});

export interface CloudflareAccessIdentity {
  email: string;
  subject: string;
}

/** Validates the Access-injected JWT and returns only bounded identity claims. */
export async function authenticateCloudflareAccess(
  request: Request,
  config: ControlConfig,
  fetcher: Fetcher = fetch,
): Promise<CloudflareAccessIdentity> {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (assertion === null || assertion.length > 16_384) {
    throw new ControlPlaneError("identity_token_invalid", 401);
  }
  try {
    const jwks = createRemoteJWKSet(
      new URL("/cdn-cgi/access/certs", config.accessTeamDomain),
      { [customFetch]: fetcher },
    );
    const verified = await jwtVerify(assertion, jwks, {
      issuer: config.accessTeamDomain,
      audience: config.accessAudience,
      algorithms: ["RS256"],
    });
    const claims = accessClaimsSchema.safeParse(verified.payload);
    if (!claims.success) throw new Error("access_claims_invalid");
    return {
      email: claims.data.email.trim().toLowerCase().normalize("NFC"),
      subject: claims.data.sub,
    };
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError("identity_token_invalid", 401);
  }
}
