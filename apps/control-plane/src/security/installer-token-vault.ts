import { z } from "zod";
import type { InstallerTokenSet } from "../adapters/cloudflare-installer";

const encoder = new TextEncoder();

const storedInstallerTokenSchema = z.object({
  accessToken: z.string().min(1).max(32_768),
  refreshToken: z.string().min(1).max(32_768),
  expiresAt: z.number().int().positive(),
  grantedScopes: z.array(z.string().min(1).max(128)).min(1).max(32),
}).strict();

/** Encodes bounded ciphertext without relying on a variadic argument expansion. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decodes one bounded ciphertext field. */
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length === 0 || value.length > 131_072) throw new Error("installer_token_invalid");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Decodes the control-plane token-encryption secret as exactly 32 bytes. */
function decodeMasterKey(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== 32) throw new Error("invalid length");
    return bytes;
  } catch {
    throw new Error("installer_token_encryption_unavailable");
  }
}

/** Imports the control-plane token-encryption key as non-exportable AES-GCM material. */
async function importMasterKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeMasterKey(value),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Binds encrypted authorization to its owner and selected Cloudflare account. */
function associatedData(ownerId: string, accountId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`later-gator-installer-token:v1:${ownerId}:${accountId}`);
}

export interface EncryptedInstallerToken {
  ciphertext: string;
  nonce: string;
  expiresAt: number;
}

/** Encrypts renewable Cloudflare authorization before any database persistence. */
export async function encryptInstallerToken(
  masterKey: string,
  ownerId: string,
  accountId: string,
  token: InstallerTokenSet,
  nowSeconds: number,
): Promise<EncryptedInstallerToken> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const expiresAt = nowSeconds + token.expiresIn;
  const plaintext = encoder.encode(JSON.stringify({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt,
    grantedScopes: token.grantedScopes,
  }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associatedData(ownerId, accountId) },
    await importMasterKey(masterKey),
    plaintext,
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    nonce: toBase64(nonce),
    expiresAt,
  };
}

/** Decrypts an installer token only for server-side Cloudflare API work. */
export async function decryptInstallerToken(
  masterKey: string,
  ownerId: string,
  accountId: string,
  encrypted: { ciphertext: string; nonce: string },
): Promise<z.infer<typeof storedInstallerTokenSchema>> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(encrypted.nonce),
      additionalData: associatedData(ownerId, accountId),
    },
    await importMasterKey(masterKey),
    fromBase64(encrypted.ciphertext),
  );
  const parsed = storedInstallerTokenSchema.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown,
  );
  if (!parsed.success) throw new Error("installer_token_invalid");
  return parsed.data;
}
