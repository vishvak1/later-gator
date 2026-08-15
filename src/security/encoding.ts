const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes a string as UTF-8 bytes. */
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

/** Decodes bytes as UTF-8 text. */
export function decodeUtf8(value: ArrayBuffer): string {
  return decoder.decode(value);
}

/** Returns cryptographically secure random bytes of the requested length. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Encodes bytes as standard base64. */
export function toBase64(value: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decodes standard base64 into bytes. */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Hashes a string with SHA-256 and returns base64. */
export async function sha256Base64(
  value: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const bytes = typeof value === "string" ? utf8(value) : value;
  return toBase64(await crypto.subtle.digest("SHA-256", bytes));
}

/** Compares two strings without leaking their first differing position. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}
