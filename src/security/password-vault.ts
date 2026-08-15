import {
  constantTimeEqual,
  fromBase64,
  randomBytes,
  sha256Base64,
  toBase64,
  utf8,
} from "./encoding";

export const PBKDF2_ITERATIONS = 100_000;
const VERIFIER = "later-gator-password-verifier-v1";

interface AuthConfigRow {
  schema_version: number;
  kdf_name: string;
  kdf_iterations: number;
  salt: string;
  wrapped_key: string;
  wrap_nonce: string;
  verifier_ciphertext: string;
  verifier_nonce: string;
}

export interface UnlockedVault {
  dataKey: CryptoKey;
  rawDataKey: Uint8Array<ArrayBuffer>;
}

/**
 * The secret is named `PASSWORD` so the Deploy to Cloudflare form asks for
 * "PASSWORD" rather than "BOOTSTRAP_PASSWORD", which read like an internal
 * detail. `BOOTSTRAP_PASSWORD` is still accepted so a deployment created under
 * the old name can still complete its first sign-in.
 */
export function getBootstrapPassword(env: Env): string | null {
  const bindings = env as unknown as Record<string, unknown>;
  for (const name of ["PASSWORD", "BOOTSTRAP_PASSWORD"]) {
    const value = bindings[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Derives the password wrapping key with the stored PBKDF2 parameters. */
async function deriveWrappingKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const sourceKey = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    sourceKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Imports raw key bytes as a non-exportable AES-GCM data key. */
async function importDataKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypts bytes with AES-GCM and returns base64 ciphertext plus its random nonce. */
async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  return { ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) };
}

/** Decrypts base64 AES-GCM ciphertext into its original bytes. */
async function decrypt(
  key: CryptoKey,
  ciphertext: string,
  nonce: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(nonce) },
    key,
    fromBase64(ciphertext),
  );
  return new Uint8Array(plaintext);
}

/** Initializes encrypted key material or unlocks it with the supplied password. */
export async function unlockOrInitializeVault(
  db: D1Database,
  env: Env,
  password: string,
): Promise<UnlockedVault | null> {
  const config = await db
    .prepare(
      `SELECT schema_version, kdf_name, kdf_iterations, salt, wrapped_key, wrap_nonce,
              verifier_ciphertext, verifier_nonce
         FROM auth_config
        WHERE id = 1`,
    )
    .first<AuthConfigRow>();

  if (config === null) {
    const bootstrapPassword = getBootstrapPassword(env);
    if (bootstrapPassword === null || !constantTimeEqual(password, bootstrapPassword)) return null;

    const salt = randomBytes(16);
    const wrappingKey = await deriveWrappingKey(password, salt, PBKDF2_ITERATIONS);
    const rawDataKey = randomBytes(32);
    const dataKey = await importDataKey(rawDataKey);
    const wrapped = await encrypt(wrappingKey, rawDataKey);
    const verifier = await encrypt(dataKey, utf8(VERIFIER));
    const now = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO auth_config (
          id, schema_version, kdf_name, kdf_iterations, salt, wrapped_key, wrap_nonce,
          verifier_ciphertext, verifier_nonce, created_at, updated_at
        ) VALUES (1, 1, 'PBKDF2-SHA256', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        PBKDF2_ITERATIONS,
        toBase64(salt),
        wrapped.ciphertext,
        wrapped.nonce,
        verifier.ciphertext,
        verifier.nonce,
        now,
        now,
      )
      .run();

    return { dataKey, rawDataKey };
  }

  if (
    config.schema_version !== 1 ||
    config.kdf_name !== "PBKDF2-SHA256" ||
    config.kdf_iterations !== PBKDF2_ITERATIONS
  ) {
    throw new Error("unsupported_auth_config");
  }

  try {
    const wrappingKey = await deriveWrappingKey(
      password,
      fromBase64(config.salt),
      config.kdf_iterations,
    );
    const rawDataKey = await decrypt(wrappingKey, config.wrapped_key, config.wrap_nonce);
    const dataKey = await importDataKey(rawDataKey);
    const verifier = await decrypt(
      dataKey,
      config.verifier_ciphertext,
      config.verifier_nonce,
    );
    if (!constantTimeEqual(new TextDecoder().decode(verifier), VERIFIER)) return null;
    return { dataKey, rawDataKey };
  } catch {
    await sha256Base64(password);
    return null;
  }
}

/** Imports raw key bytes and encrypts plaintext for storage in D1. */
export async function encryptWithRawKey(
  rawKey: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<{ ciphertext: string; nonce: string }> {
  return encrypt(await importDataKey(rawKey), plaintext);
}

/** Imports raw key bytes and decrypts one stored ciphertext value. */
export async function decryptWithRawKey(
  rawKey: Uint8Array<ArrayBuffer>,
  ciphertext: string,
  nonce: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return decrypt(await importDataKey(rawKey), ciphertext, nonce);
}
