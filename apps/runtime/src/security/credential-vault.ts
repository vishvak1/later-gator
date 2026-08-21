import { z } from "zod";
import { fromBase64, randomBytes, toBase64, utf8 } from "./encoding";

const credentialRowSchema = z
  .object({
    ciphertext: z.string().min(16).max(32_768),
    nonce: z.string().min(16).max(128),
    schema_version: z.literal(1),
  })
  .strict();

/** Imports the per-installation Worker secret as a non-exportable AES-GCM key. */
async function instanceMasterKey(env: Env): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(env.INSTANCE_MASTER_KEY);
  } catch {
    throw new Error("instance_master_key_unavailable");
  }
  if (raw.byteLength !== 32) throw new Error("instance_master_key_unavailable");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Returns provider-bound associated data so ciphertext cannot change credential type. */
function credentialAssociatedData(provider: "openai" | "anthropic"): Uint8Array<ArrayBuffer> {
  return utf8(`later-gator-provider-credential:v1:${provider}`);
}

/** Encrypts and upserts one provider credential under the installation secret. */
export async function saveProviderCredential(
  env: Env,
  provider: "openai" | "anthropic",
  credential: string,
): Promise<void> {
  const nonce = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: credentialAssociatedData(provider),
    },
    await instanceMasterKey(env),
    utf8(credential),
  );
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO encrypted_credentials (
        id, credential_type, ciphertext, nonce, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(credential_type) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at`,
    )
    .bind(
      `provider_${provider}`,
      provider,
      toBase64(ciphertext),
      toBase64(nonce),
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
  const stored = await env.DB
    .prepare(
      `SELECT ciphertext, nonce, schema_version
         FROM encrypted_credentials
        WHERE credential_type = ?`,
    )
    .bind(provider)
    .first<unknown>();
  if (stored === null) return null;
  const row = credentialRowSchema.safeParse(stored);
  if (!row.success) throw new Error("provider_credential_invalid");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(row.data.nonce),
      additionalData: credentialAssociatedData(provider),
    },
    await instanceMasterKey(env),
    fromBase64(row.data.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** Permanently deletes a provider's encrypted credential record. */
export async function deleteProviderCredential(
  db: D1Database,
  provider: "openai" | "anthropic",
): Promise<void> {
  await db
    .prepare("DELETE FROM encrypted_credentials WHERE credential_type = ?")
    .bind(provider)
    .run();
}
