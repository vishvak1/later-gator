import { fromBase64, randomBytes, toBase64, utf8 } from "./encoding";
import { encryptWithRawKey, PBKDF2_ITERATIONS } from "./password-vault";
import { getBootstrapPassword } from "./password-vault";

interface CredentialRow {
  service_ciphertext: string | null;
  service_nonce: string | null;
}

/** Derives the non-exportable AES-GCM key used for unattended provider access. */
async function serviceKey(
  env: Env,
  provider: "openai" | "anthropic",
): Promise<CryptoKey> {
  const secret = getBootstrapPassword(env);
  if (secret === null) throw new Error("bootstrap_password_unavailable");
  const source = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: utf8(`later-gator-service-credential-v1:${provider}`),
    },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts a provider credential for background jobs using the service key. */
async function encryptForService(
  env: Env,
  provider: "openai" | "anthropic",
  plaintext: string,
): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await serviceKey(env, provider),
    utf8(plaintext),
  );
  return { ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) };
}

/** Decrypts a stored provider credential for an authenticated background job. */
async function decryptForService(
  env: Env,
  provider: "openai" | "anthropic",
  ciphertext: string,
  nonce: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(nonce) },
    await serviceKey(env, provider),
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** Encrypts and upserts one provider credential without returning its plaintext. */
export async function saveProviderCredential(
  env: Env,
  rawDataKey: Uint8Array<ArrayBuffer>,
  provider: "openai" | "anthropic",
  credential: string,
): Promise<void> {
  const dashboardCopy = await encryptWithRawKey(rawDataKey, utf8(credential));
  const serviceCopy = await encryptForService(env, provider, credential);
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO encrypted_credentials (
        id, credential_type, ciphertext, nonce, service_ciphertext, service_nonce,
        schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(credential_type) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        service_ciphertext = excluded.service_ciphertext,
        service_nonce = excluded.service_nonce,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at`,
    )
    .bind(
      `provider_${provider}`,
      provider,
      dashboardCopy.ciphertext,
      dashboardCopy.nonce,
      serviceCopy.ciphertext,
      serviceCopy.nonce,
      now,
      now,
    )
    .run();
}

/** Loads and decrypts one provider credential for Worker-side use only. */
export async function loadProviderCredentialForWorker(
  env: Env,
  provider: "openai" | "anthropic",
): Promise<string | null> {
  const row = await env.DB
    .prepare(
      `SELECT service_ciphertext, service_nonce
         FROM encrypted_credentials
        WHERE credential_type = ?`,
    )
    .bind(provider)
    .first<CredentialRow>();
  if (row?.service_ciphertext === null || row?.service_ciphertext === undefined) return null;
  if (row.service_nonce === null) return null;
  return decryptForService(env, provider, row.service_ciphertext, row.service_nonce);
}

/** Permanently deletes a provider's encrypted credential record. */
export async function deleteProviderCredential(
  db: D1Database,
  provider: "openai" | "anthropic",
): Promise<void> {
  await db.prepare("DELETE FROM encrypted_credentials WHERE credential_type = ?").bind(provider).run();
}
