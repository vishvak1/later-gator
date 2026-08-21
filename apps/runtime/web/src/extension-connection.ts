const CONNECTION_CODE_PREFIX = "later-gator.";

/** Encodes bytes as unpadded base64url for a copy-safe pairing code. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** Encodes the deployment origin and scoped token into one pairing code. */
export function extensionConnectionCode(deployment: string, token: string): string {
  const payload = JSON.stringify({
    deployment: new URL(deployment).origin,
    token,
  });
  return CONNECTION_CODE_PREFIX + base64Url(new TextEncoder().encode(payload));
}
