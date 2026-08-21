import { env, exports } from "cloudflare:workers";
import type { PairingGrantPayload } from "@later-gator/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeExtensionDevice } from "../src/security/capture-credentials";
import { toBase64Url } from "../src/security/encoding";
import { capturePairingExchange } from "../src/routes/capture-pairing";

const CONTROL_PLANE_ORIGIN = "https://control-plane.test";
const INSTALLATION_ID = "test-installation-0001";
const KEY_ID = "pairing-test-key";
const DEVICE_ID = "device_12345678";

/** Signs one runtime pairing grant with a generated test-only P-256 key. */
async function pairingFixture(overrides: Partial<PairingGrantPayload> = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const now = Math.floor(Date.now() / 1000);
  const payload: PairingGrantPayload = {
    contractVersion: 1,
    issuer: CONTROL_PLANE_ORIGIN,
    audience: INSTALLATION_ID,
    subject: "owner-subject-0001",
    installationId: INSTALLATION_ID,
    extensionDeviceId: DEVICE_ID,
    requestedScopes: ["capture:create", "capture:duplicates"],
    nonce: "n".repeat(43),
    jti: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + 120,
    ...overrides,
  };
  const header = toBase64Url(new TextEncoder().encode(JSON.stringify({
    alg: "ES256",
    kid: KEY_ID,
    typ: "LG-PAIRING",
  })));
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({
    keys: [{
      alg: "ES256",
      crv: "P-256",
      kid: KEY_ID,
      kty: "EC",
      use: "sig",
      x: publicJwk.x,
      y: publicJwk.y,
    }],
  }))));
  return `${signingInput}.${toBase64Url(signature)}`;
}

/** Exchanges one grant through the public CORS pairing endpoint. */
async function exchange(grant: string): Promise<Response> {
  return capturePairingExchange(new Request("https://later-gator.test/api/capture/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "chrome-extension://example" },
    body: JSON.stringify({ grant, deviceId: DEVICE_ID, deviceName: "Chrome on Mac" }),
  }), env);
}

afterEach(() => vi.unstubAllGlobals());

describe("Chrome extension pairing", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM extension_devices"),
      env.DB.prepare("DELETE FROM extension_pairing_jtis"),
      env.DB.prepare("DELETE FROM capture_credentials"),
      env.DB.prepare("DELETE FROM owner_identity"),
      env.DB.prepare(
        "INSERT INTO owner_identity (id, subject, bound_at) VALUES (1, 'owner-subject-0001', ?)",
      ).bind(new Date().toISOString()),
    ]);
  });

  it("exchanges a matching grant once and revokes its narrow capture credential", async () => {
    const grant = await pairingFixture();
    const response = await exchange(grant);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.json<{ credential: { token: string } }>();
    expect(body.credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const options = await exports.default.fetch("https://later-gator.test/api/capture/options", {
      headers: { authorization: `Bearer ${body.credential.token}` },
    });
    expect(options.status).toBe(200);
    expect(await env.DB.prepare("SELECT name FROM extension_devices WHERE id = ?")
      .bind(DEVICE_ID).first()).toEqual({ name: "Chrome on Mac" });

    expect(await revokeExtensionDevice(env.DB, DEVICE_ID)).toBe(true);
    const revoked = await exports.default.fetch("https://later-gator.test/api/capture/options", {
      headers: { authorization: `Bearer ${body.credential.token}` },
    });
    expect(revoked.status).toBe(401);
  });

  it("rejects grant replay, wrong-owner, and wrong-device exchanges", async () => {
    const grant = await pairingFixture();
    expect((await exchange(grant)).status).toBe(201);
    const replay = await exchange(grant);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "pairing_replayed" } });

    const wrongOwner = await pairingFixture({ subject: "different-owner-0002" });
    expect((await exchange(wrongOwner)).status).toBe(403);

    const wrongDevice = await pairingFixture({ extensionDeviceId: "another_device_123" });
    expect((await exchange(wrongDevice)).status).toBe(403);
  });
});
