import { ControlPlaneError } from "../domain/errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encodes bytes without padding for OAuth and session tokens. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decodes a bounded base64url value into bytes. */
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 32_768) {
    throw new ControlPlaneError("identity_token_invalid", 401);
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ControlPlaneError("identity_token_invalid", 401);
  }
}

/** Decodes base64url text as strict UTF-8. */
export function decodeBase64UrlText(value: string): string {
  try {
    return decoder.decode(decodeBase64Url(value));
  } catch {
    throw new ControlPlaneError("identity_token_invalid", 401);
  }
}

/** Creates a cryptographically random, URL-safe token. */
export function randomToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new RangeError("Random token byte length is outside the allowed range");
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/** Hashes text to base64url for PKCE and opaque database lookups. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

/** Compares same-length tokens without exiting on the first different byte. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/** Copies a typed array into an ArrayBuffer accepted by Web Crypto. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
