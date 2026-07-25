import type { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";

const MCP_SECRET_BYTES = 32;
const MCP_SECRET_LENGTH = MCP_SECRET_BYTES * 2;

export async function getOrCreateMcpSecret(
  store: EncryptedCredentialStore,
): Promise<string> {
  const existing = await store.get("mcpPath");
  if (existing !== null && existing.length === MCP_SECRET_LENGTH) return existing;

  const secret = generateMcpSecret();
  await store.set("mcpPath", secret);
  return secret;
}

export function generateMcpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(MCP_SECRET_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
