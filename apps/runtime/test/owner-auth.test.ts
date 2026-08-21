import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerAssertionPayload } from "@later-gator/contracts";
import { toBase64Url } from "../src/security/encoding";
import {
  completeOwnerLogin,
  type OwnerLoginFailureCode,
} from "../src/security/owner-auth";

const RUNTIME_ORIGIN = "https://later-gator.test";
const CONTROL_PLANE_ORIGIN = "https://control-plane.test";
const INSTALLATION_ID = "test-installation-0001";
const KEY_ID = "test-key-0001";

interface TestKeyRing {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

interface LoginRequest {
  nonce: string;
  state: string;
}

/** Generates one extractable test-only P-256 signing key. */
async function generateTestKey(): Promise<TestKeyRing> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

/** Installs a bounded mock for the control plane's public assertion keys. */
function mockJwks(keys: { kid: string; publicJwk: JsonWebKey }[]): void {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({
    keys: keys.map(({ kid, publicJwk }) => ({
      alg: "ES256",
      crv: "P-256",
      kid,
      kty: "EC",
      use: "sig",
      x: publicJwk.x,
      y: publicJwk.y,
    })),
  }))));
}

/** Starts a real runtime login request and extracts its opaque callback values. */
async function startLogin(): Promise<LoginRequest> {
  const response = await exports.default.fetch(`${RUNTIME_ORIGIN}/auth/login`, {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const destination = new URL(response.headers.get("location") ?? "");
  const nonce = destination.searchParams.get("nonce");
  const state = destination.searchParams.get("state");
  if (nonce === null || state === null) throw new Error("Missing owner-login request values");
  return { nonce, state };
}

/** Signs a test assertion using the same ES256 compact shape as the control plane. */
async function signAssertion(
  key: CryptoKey,
  request: LoginRequest,
  overrides: Partial<OwnerAssertionPayload> = {},
  kid = KEY_ID,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: OwnerAssertionPayload = {
    contractVersion: 1,
    issuer: CONTROL_PLANE_ORIGIN,
    audience: INSTALLATION_ID,
    subject: "owner-subject-0001",
    installationId: INSTALLATION_ID,
    nonce: request.nonce,
    jti: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + 120,
    ...overrides,
  };
  const encodedHeader = toBase64Url(new TextEncoder().encode(JSON.stringify({
    alg: "ES256",
    kid,
    typ: "JWT",
  })));
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(signature)}`;
}

/** Builds the runtime callback request for one signed assertion. */
function callbackRequest(request: LoginRequest, assertion: string): Request {
  const url = new URL("/auth/callback", RUNTIME_ORIGIN);
  url.searchParams.set("state", request.state);
  url.searchParams.set("assertion", assertion);
  return new Request(url);
}

/** Asserts that owner login fails with one privacy-safe outcome code. */
async function expectLoginFailure(
  request: Request,
  code: OwnerLoginFailureCode,
): Promise<void> {
  await expect(completeOwnerLogin(request, env)).rejects.toMatchObject({ safeCode: code });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installation-bound owner login", () => {
  it("verifies ES256, binds one owner, consumes the assertion, and creates an ordinary session", async () => {
    const keys = await generateTestKey();
    mockJwks([{ kid: KEY_ID, publicJwk: keys.publicJwk }]);
    const login = await startLogin();
    const assertion = await signAssertion(keys.privateKey, login);
    const session = await completeOwnerLogin(callbackRequest(login, assertion), env);
    expect(session.cookie).toContain("lg_session=");
    expect(session.csrfToken).toEqual(expect.any(String));
    expect(await env.DB.prepare("SELECT subject FROM owner_identity WHERE id = 1").first()).toEqual({
      subject: "owner-subject-0001",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_assertion_jtis").first()).toEqual({
      count: 1,
    });
    const sessionColumns = await env.DB.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
    expect(sessionColumns.results.map((column) => column.name)).not.toContain("encrypted_data_key");
  });

  it("rejects callback and JTI replay", async () => {
    const keys = await generateTestKey();
    mockJwks([{ kid: KEY_ID, publicJwk: keys.publicJwk }]);
    const login = await startLogin();
    const assertion = await signAssertion(keys.privateKey, login);
    await completeOwnerLogin(callbackRequest(login, assertion), env);
    await expectLoginFailure(callbackRequest(login, assertion), "login_request_invalid");
  });

  it("rejects the wrong installation, an expired assertion, and an unavailable signing key", async () => {
    const keys = await generateTestKey();
    mockJwks([{ kid: KEY_ID, publicJwk: keys.publicJwk }]);

    const wrongInstallation = await startLogin();
    await expectLoginFailure(
      callbackRequest(wrongInstallation, await signAssertion(keys.privateKey, wrongInstallation, {
        audience: "different-installation",
        installationId: "different-installation",
      })),
      "assertion_wrong_installation",
    );

    const expired = await startLogin();
    const now = Math.floor(Date.now() / 1000);
    await expectLoginFailure(
      callbackRequest(expired, await signAssertion(keys.privateKey, expired, {
        issuedAt: now - 180,
        expiresAt: now - 60,
      })),
      "assertion_expired",
    );

    const unknownKey = await startLogin();
    await expectLoginFailure(
      callbackRequest(unknownKey, await signAssertion(
        keys.privateKey,
        unknownKey,
        {},
        "unknown-key-0001",
      )),
      "assertion_invalid",
    );
  });

  it("rejects a different owner after binding and accepts a retained rotation key", async () => {
    const oldKey = await generateTestKey();
    const newKey = await generateTestKey();
    mockJwks([
      { kid: "old-key-0001", publicJwk: oldKey.publicJwk },
      { kid: "new-key-0001", publicJwk: newKey.publicJwk },
    ]);
    const first = await startLogin();
    await completeOwnerLogin(
      callbackRequest(first, await signAssertion(oldKey.privateKey, first, {}, "old-key-0001")),
      env,
    );

    const wrongOwner = await startLogin();
    await expectLoginFailure(
      callbackRequest(wrongOwner, await signAssertion(newKey.privateKey, wrongOwner, {
        subject: "different-owner-0002",
      }, "new-key-0001")),
      "assertion_wrong_owner",
    );

    const retainedOwner = await startLogin();
    const retainedSession = await completeOwnerLogin(
      callbackRequest(retainedOwner, await signAssertion(
        newKey.privateKey,
        retainedOwner,
        {},
        "new-key-0001",
      )),
      env,
    );
    expect(typeof retainedSession.csrfToken).toBe("string");
  });
});
