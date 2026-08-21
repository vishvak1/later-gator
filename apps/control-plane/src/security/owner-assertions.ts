import {
  catalogSigningBytes,
  runtimeReleaseSigningBytes,
  ownerAssertionPayloadSchema,
  pairingGrantPayloadSchema,
  type OwnerAssertionPayload,
  type PairingGrantPayload,
  type SignedCatalogKind,
} from "@later-gator/contracts";
import { z } from "zod";
import { ControlPlaneError } from "../domain/errors";
import { encodeBase64Url, randomToken, toArrayBuffer } from "./encoding";

const signingKeySchema = z
  .object({
    kid: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u),
    y: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u),
    d: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  })
  .strict();

const signingKeyRingSchema = z
  .object({
    activeKid: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    keys: z.array(signingKeySchema).min(1).max(4),
  })
  .strict()
  .superRefine((ring, context) => {
    const ids = new Set(ring.keys.map((key) => key.kid));
    if (ids.size !== ring.keys.length) {
      context.addIssue({ code: "custom", message: "signing key IDs must be unique", path: ["keys"] });
    }
    const active = ring.keys.find((key) => key.kid === ring.activeKid);
    if (active?.d === undefined) {
      context.addIssue({ code: "custom", message: "active signing key must include private material", path: ["activeKid"] });
    }
  });

export type OwnerAssertionKeyRing = z.infer<typeof signingKeyRingSchema>;

export interface PublicOwnerAssertionJwk {
  alg: "ES256";
  crv: "P-256";
  kid: string;
  kty: "EC";
  use: "sig";
  x: string;
  y: string;
}

export interface PublicOwnerAssertionJwks {
  keys: PublicOwnerAssertionJwk[];
}

type EcdsaJwkImporter = (
  format: "jwk",
  keyData: JsonWebKey,
  algorithm: { name: "ECDSA"; namedCurve: "P-256" },
  extractable: false,
  keyUsages: readonly ["sign"],
) => Promise<CryptoKey>;

/** Parses a bounded signing-key secret and verifies its rotation invariants. */
export function parseOwnerAssertionKeyRing(serialized: string): OwnerAssertionKeyRing {
  if (serialized.length < 2 || serialized.length > 32_768) {
    throw new ControlPlaneError("signing_unavailable", 503);
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new ControlPlaneError("signing_unavailable", 503);
  }
  const parsed = signingKeyRingSchema.safeParse(value);
  if (!parsed.success) throw new ControlPlaneError("signing_unavailable", 503);
  return parsed.data;
}

/** Returns only public verification material for every retained rotation key. */
export function publicOwnerAssertionJwks(ring: OwnerAssertionKeyRing): PublicOwnerAssertionJwks {
  return {
    keys: ring.keys.map((key) => ({
      alg: "ES256",
      crv: key.crv,
      kid: key.kid,
      kty: key.kty,
      use: "sig",
      x: key.x,
      y: key.y,
    })),
  };
}

/** Signs a bounded public catalog with the active, rotatable control-plane key. */
export async function signPublicCatalog(
  ring: OwnerAssertionKeyRing,
  kind: SignedCatalogKind,
  catalog: Record<string, unknown>,
): Promise<{ signingKeyId: string; signature: string }> {
  const active = ring.keys.find((key) => key.kid === ring.activeKid);
  if (active?.d === undefined) throw new ControlPlaneError("signing_unavailable", 503);
  const importEcdsaJwk = crypto.subtle.importKey.bind(crypto.subtle) as EcdsaJwkImporter;
  const key = await importEcdsaJwk(
    "jwk",
    { crv: active.crv, d: active.d, kty: active.kty, x: active.x, y: active.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(catalogSigningBytes(kind, catalog)),
  );
  return { signingKeyId: active.kid, signature: encodeBase64Url(new Uint8Array(signature)) };
}

/** Signs one checksum-verified immutable runtime release manifest. */
export async function signRuntimeRelease(
  ring: OwnerAssertionKeyRing,
  manifest: Record<string, unknown>,
): Promise<{ signingKeyId: string; signature: string }> {
  const active = ring.keys.find((key) => key.kid === ring.activeKid);
  if (active?.d === undefined) throw new ControlPlaneError("signing_unavailable", 503);
  const importEcdsaJwk = crypto.subtle.importKey.bind(crypto.subtle) as EcdsaJwkImporter;
  const key = await importEcdsaJwk(
    "jwk",
    { crv: active.crv, d: active.d, kty: active.kty, x: active.x, y: active.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(runtimeReleaseSigningBytes(manifest)),
  );
  return { signingKeyId: active.kid, signature: encodeBase64Url(new Uint8Array(signature)) };
}

/** Issues a short-lived ES256 assertion bound to one owner and installation. */
export async function issueOwnerAssertion(
  ring: OwnerAssertionKeyRing,
  input: {
    issuer: string;
    ownerId: string;
    installationId: string;
    nonce: string;
  },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const active = ring.keys.find((key) => key.kid === ring.activeKid);
  if (active?.d === undefined) throw new ControlPlaneError("signing_unavailable", 503);
  const payload = ownerAssertionPayloadSchema.parse({
    contractVersion: 1,
    issuer: input.issuer,
    audience: input.installationId,
    subject: input.ownerId,
    installationId: input.installationId,
    nonce: input.nonce,
    jti: randomToken(),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 120,
  } satisfies OwnerAssertionPayload);
  const header = { alg: "ES256", kid: active.kid, typ: "JWT" } as const;
  const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  // The Workers runtime accepts EC JWK imports although the WebWorker lib's
  // overload set omits this valid Web Crypto combination.
  const importEcdsaJwk = crypto.subtle.importKey.bind(crypto.subtle) as EcdsaJwkImporter;
  const privateJwk: JsonWebKey = {
    crv: active.crv,
    d: active.d,
    kty: active.kty,
    x: active.x,
    y: active.y,
  };
  const key = await importEcdsaJwk(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Issues a short-lived ES256 grant bound to one installation and extension device. */
export async function issuePairingGrant(
  ring: OwnerAssertionKeyRing,
  input: {
    issuer: string;
    ownerId: string;
    installationId: string;
    extensionDeviceId: string;
    nonce: string;
    jti: string;
  },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const active = ring.keys.find((key) => key.kid === ring.activeKid);
  if (active?.d === undefined) throw new ControlPlaneError("signing_unavailable", 503);
  const payload = pairingGrantPayloadSchema.parse({
    contractVersion: 1,
    issuer: input.issuer,
    audience: input.installationId,
    subject: input.ownerId,
    installationId: input.installationId,
    extensionDeviceId: input.extensionDeviceId,
    requestedScopes: ["capture:create", "capture:duplicates"],
    nonce: input.nonce,
    jti: input.jti,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 120,
  } satisfies PairingGrantPayload);
  const header = { alg: "ES256", kid: active.kid, typ: "LG-PAIRING" } as const;
  const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const importEcdsaJwk = crypto.subtle.importKey.bind(crypto.subtle) as EcdsaJwkImporter;
  const key = await importEcdsaJwk(
    "jwk",
    { crv: active.crv, d: active.d, kty: active.kty, x: active.x, y: active.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}
