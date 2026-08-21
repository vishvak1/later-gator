import {
  base64UrlSchema,
  ownerAssertionPayloadSchema,
  type OwnerAssertionPayload,
} from "@later-gator/contracts";
import { z } from "zod";
import { readRuntimeIdentityConfig } from "../domain/runtime-config";
import {
  constantTimeEqual,
  fromBase64Url,
  randomBytes,
  sha256Base64,
  toBase64Url,
} from "./encoding";
import { createSession } from "./sessions";

const LOGIN_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
const MAXIMUM_JWKS_BYTES = 32 * 1024;

const assertionHeaderSchema = z
  .object({
    alg: z.literal("ES256"),
    kid: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    typ: z.enum(["JWT", "LG-PAIRING"]),
  })
  .strict();

const publicJwkSchema = z
  .object({
    alg: z.literal("ES256"),
    crv: z.literal("P-256"),
    kid: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    kty: z.literal("EC"),
    use: z.literal("sig"),
    x: base64UrlSchema,
    y: base64UrlSchema,
  })
  .strict();

const publicJwksSchema = z
  .object({ keys: z.array(publicJwkSchema).min(1).max(4) })
  .strict()
  .refine((jwks) => new Set(jwks.keys.map((key) => key.kid)).size === jwks.keys.length, {
    message: "Signing key IDs must be unique.",
  });

const assertionCallbackSchema = z
  .object({
    assertion: z.string().min(32).max(8192),
    state: base64UrlSchema,
  })
  .strict();

interface OwnerLoginRequestRow {
  nonce_hash: string;
}

interface OwnerIdentityRow {
  subject: string;
}

export type OwnerLoginFailureCode =
  | "assertion_expired"
  | "assertion_invalid"
  | "assertion_replayed"
  | "assertion_wrong_installation"
  | "assertion_wrong_owner"
  | "identity_provider_unavailable"
  | "login_request_invalid"
  | "runtime_identity_config_unavailable";

export class OwnerLoginError extends Error {
  readonly safeCode: OwnerLoginFailureCode;

  /** Creates a bounded owner-login failure without retaining assertion material. */
  constructor(safeCode: OwnerLoginFailureCode) {
    super(safeCode);
    this.name = "OwnerLoginError";
    this.safeCode = safeCode;
  }
}

/** Parses one bounded JSON object from a JWT segment. */
function parseJwtSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment) || segment.length > 4096) {
    throw new OwnerLoginError("assertion_invalid");
  }
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(segment))) as unknown;
  } catch {
    throw new OwnerLoginError("assertion_invalid");
  }
}

/** Fetches and validates the control plane's bounded public assertion-key set. */
async function fetchAssertionJwks(
  controlPlaneOrigin: string,
): Promise<z.infer<typeof publicJwksSchema>> {
  const url = new URL("/.well-known/later-gator-jwks.json", controlPlaneOrigin);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch {
    throw new OwnerLoginError("identity_provider_unavailable");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    response.status !== 200 ||
    (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_JWKS_BYTES)
  ) {
    throw new OwnerLoginError("identity_provider_unavailable");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAXIMUM_JWKS_BYTES) {
    throw new OwnerLoginError("identity_provider_unavailable");
  }
  try {
    const parsed = publicJwksSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
    if (!parsed.success) throw new OwnerLoginError("identity_provider_unavailable");
    return parsed.data;
  } catch (error) {
    if (error instanceof OwnerLoginError) throw error;
    throw new OwnerLoginError("identity_provider_unavailable");
  }
}

/** Verifies a typed ES256 control-plane token and returns its schema-checked payload. */
export async function verifyControlPlaneSignedPayload<T extends { issuer: string }>(
  assertion: string,
  env: Env,
  tokenType: "JWT" | "LG-PAIRING",
  payloadSchema: z.ZodType<T>,
): Promise<T> {
  const parts = assertion.split(".");
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new OwnerLoginError("assertion_invalid");
  }
  const header = assertionHeaderSchema.safeParse(parseJwtSegment(encodedHeader));
  const payload = payloadSchema.safeParse(parseJwtSegment(encodedPayload));
  if (!header.success || header.data.typ !== tokenType || !payload.success) {
    throw new OwnerLoginError("assertion_invalid");
  }
  let config;
  try {
    config = readRuntimeIdentityConfig(env);
  } catch {
    throw new OwnerLoginError("runtime_identity_config_unavailable");
  }
  if (payload.data.issuer !== config.controlPlaneOrigin) {
    throw new OwnerLoginError("assertion_invalid");
  }

  const jwks = await fetchAssertionJwks(config.controlPlaneOrigin);
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.data.kid);
  if (jwk === undefined) throw new OwnerLoginError("assertion_invalid");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { crv: jwk.crv, ext: true, key_ops: ["verify"], kty: jwk.kty, x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new OwnerLoginError("assertion_invalid");
  }
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new OwnerLoginError("assertion_invalid");
  return payload.data;
}

/** Verifies one ES256 owner assertion against the control plane's current key ring. */
async function verifyOwnerAssertion(assertion: string, env: Env): Promise<OwnerAssertionPayload> {
  const payload = await verifyControlPlaneSignedPayload(
    assertion,
    env,
    "JWT",
    ownerAssertionPayloadSchema,
  );
  let config;
  try {
    config = readRuntimeIdentityConfig(env);
  } catch {
    throw new OwnerLoginError("runtime_identity_config_unavailable");
  }
  if (
    payload.audience !== config.installationId ||
    payload.installationId !== config.installationId
  ) {
    throw new OwnerLoginError("assertion_wrong_installation");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= nowSeconds) throw new OwnerLoginError("assertion_expired");
  if (payload.issuedAt > nowSeconds + 30) throw new OwnerLoginError("assertion_invalid");
  return payload;
}

/** Creates one local login request and redirects the browser to the control plane. */
export async function beginOwnerLogin(request: Request, env: Env): Promise<Response> {
  let config;
  try {
    config = readRuntimeIdentityConfig(env);
  } catch {
    throw new OwnerLoginError("runtime_identity_config_unavailable");
  }
  if (new URL(request.url).origin !== config.publicOrigin) {
    throw new OwnerLoginError("runtime_identity_config_unavailable");
  }
  const state = toBase64Url(randomBytes(32));
  const nonce = toBase64Url(randomBytes(32));
  const now = new Date();
  await env.DB.batch([
    env.DB
      .prepare("DELETE FROM owner_login_requests WHERE expires_at <= ?")
      .bind(now.toISOString()),
    env.DB
      .prepare(
        `INSERT INTO owner_login_requests (
          state_hash, nonce_hash, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(
        await sha256Base64(`owner-login-state:${state}`),
        await sha256Base64(`owner-login-nonce:${nonce}`),
        now.toISOString(),
        new Date(now.getTime() + LOGIN_LIFETIME_MILLISECONDS).toISOString(),
      ),
  ]);
  const destination = new URL("/runtime/login", config.controlPlaneOrigin);
  destination.searchParams.set("installation_id", config.installationId);
  destination.searchParams.set("callback", new URL("/auth/callback", config.publicOrigin).toString());
  destination.searchParams.set("nonce", nonce);
  destination.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { location: destination.toString(), "cache-control": "no-store" },
  });
}

/** Validates a returned assertion, binds the owner once, and creates a local session. */
export async function completeOwnerLogin(
  request: Request,
  env: Env,
): Promise<{ cookie: string; csrfToken: string }> {
  const url = new URL(request.url);
  const parsed = assertionCallbackSchema.safeParse({
    assertion: url.searchParams.get("assertion"),
    state: url.searchParams.get("state"),
  });
  if (!parsed.success) throw new OwnerLoginError("login_request_invalid");
  const stateHash = await sha256Base64(`owner-login-state:${parsed.data.state}`);
  const login = await env.DB
    .prepare(
      `SELECT nonce_hash
         FROM owner_login_requests
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(stateHash, new Date().toISOString())
    .first<OwnerLoginRequestRow>();
  if (login === null) throw new OwnerLoginError("login_request_invalid");

  const payload = await verifyOwnerAssertion(parsed.data.assertion, env);
  const nonceHash = await sha256Base64(`owner-login-nonce:${payload.nonce}`);
  if (!constantTimeEqual(nonceHash, login.nonce_hash)) {
    throw new OwnerLoginError("assertion_invalid");
  }
  const owner = await env.DB
    .prepare("SELECT subject FROM owner_identity WHERE id = 1")
    .first<OwnerIdentityRow>();
  if (owner !== null && owner.subject !== payload.subject) {
    throw new OwnerLoginError("assertion_wrong_owner");
  }

  try {
    const consumedAt = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO owner_identity (id, subject, bound_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(payload.subject, consumedAt),
      env.DB
        .prepare(
          `UPDATE owner_login_requests
              SET consumed_at = ?
            WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
              AND EXISTS (
                SELECT 1 FROM owner_identity WHERE id = 1 AND subject = ?
              )`,
        )
        .bind(consumedAt, stateHash, consumedAt, payload.subject),
      env.DB
        .prepare(
          `INSERT INTO owner_assertion_jtis (jti_hash, consumed_at)
           SELECT ?, ?
            WHERE EXISTS (
              SELECT 1 FROM owner_identity WHERE id = 1 AND subject = ?
            )`,
        )
        .bind(
          await sha256Base64(`owner-assertion-jti:${payload.jti}`),
          consumedAt,
          payload.subject,
        ),
    ]);
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      const boundOwner = await env.DB
        .prepare("SELECT subject FROM owner_identity WHERE id = 1")
        .first<OwnerIdentityRow>();
      throw new OwnerLoginError(
        boundOwner !== null && boundOwner.subject !== payload.subject
          ? "assertion_wrong_owner"
          : "assertion_replayed",
      );
    }
  } catch (error) {
    if (error instanceof OwnerLoginError) throw error;
    throw new OwnerLoginError("assertion_replayed");
  }
  return createSession(env.DB);
}
