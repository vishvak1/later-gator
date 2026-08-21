import { env } from "cloudflare:workers";
import { ownerAssertionPayloadSchema } from "@later-gator/contracts";
import { describe, expect, it } from "vitest";
import {
  issueOwnerAssertion,
  parseOwnerAssertionKeyRing,
  publicOwnerAssertionJwks,
} from "../src/security/owner-assertions";
import { decodeBase64Url, decodeBase64UrlText, toArrayBuffer } from "../src/security/encoding";

/** Parses one JSON segment from a compact JWS. */
function parseSegment(value: string): unknown {
  return JSON.parse(decodeBase64UrlText(value)) as unknown;
}

describe("owner assertion signing", () => {
  it("signs an installation-bound assertion with the active rotation key", async () => {
    const ring = parseOwnerAssertionKeyRing(env.OWNER_ASSERTION_SIGNING_KEYS);
    const token = await issueOwnerAssertion(
      ring,
      {
        issuer: "https://latergator.test",
        ownerId: "owner_12345678",
        installationId: "installation_12345678",
        nonce: "abcdefghijklmnopqrstuvwxyz_123456",
      },
      1_800_000_000,
    );
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    const header = parseSegment(parts[0] ?? "") as Record<string, unknown>;
    expect(header).toEqual({ alg: "ES256", kid: "test-owner-key-active", typ: "JWT" });
    const payload = ownerAssertionPayloadSchema.parse(parseSegment(parts[1] ?? ""));
    expect(payload).toMatchObject({
      audience: "installation_12345678",
      expiresAt: 1_800_000_120,
      installationId: "installation_12345678",
      issuedAt: 1_800_000_000,
      subject: "owner_12345678",
    });

    const active = publicOwnerAssertionJwks(ring).keys.find(
      (key) => key.kid === "test-owner-key-active",
    );
    expect(active).toBeDefined();
    if (active === undefined) throw new Error("Active public key was not published");
    type EcdsaVerifierImporter = (
      format: "jwk",
      keyData: JsonWebKey,
      algorithm: { name: "ECDSA"; namedCurve: "P-256" },
      extractable: false,
      keyUsages: readonly ["verify"],
    ) => Promise<CryptoKey>;
    const importEcdsaJwk = crypto.subtle.importKey.bind(crypto.subtle) as EcdsaVerifierImporter;
    const publicKey = await importEcdsaJwk(
      "jwk",
      active,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        toArrayBuffer(decodeBase64Url(parts[2] ?? "")),
        toArrayBuffer(
          new TextEncoder().encode(`${parts[0] ?? ""}.${parts[1] ?? ""}`),
        ),
      ),
    ).resolves.toBe(true);
  });

  it("retains previous public keys and rejects invalid rotation state", () => {
    const ring = parseOwnerAssertionKeyRing(env.OWNER_ASSERTION_SIGNING_KEYS);
    expect(publicOwnerAssertionJwks(ring).keys).toHaveLength(2);
    expect(() =>
      parseOwnerAssertionKeyRing(
        JSON.stringify({
          activeKid: "missing_key",
          keys: [
            {
              kid: "public_key_1",
              kty: "EC",
              crv: "P-256",
              x: "abcdefghijklmnopqrstuvwxyz_123456",
              y: "abcdefghijklmnopqrstuvwxyz_123456",
            },
          ],
        }),
      ),
    ).toThrow("signing_unavailable");
  });
});
