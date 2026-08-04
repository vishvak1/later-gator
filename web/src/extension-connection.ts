const CONNECTION_CODE_PREFIX = "later-gator-v1.";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function extensionConnectionCode(deployment: string, token: string): string {
  const payload = JSON.stringify({
    version: 1,
    deployment: new URL(deployment).origin,
    token,
  });
  return CONNECTION_CODE_PREFIX + base64Url(new TextEncoder().encode(payload));
}
