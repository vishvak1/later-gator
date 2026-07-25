import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { EncryptedCredentialStore } from "../../src/adapters/encrypted-credential-store";
import {
  generateMcpSecret,
  getOrCreateMcpSecret,
} from "../../src/application/mcp-secret";

describe("MCP connection secret", () => {
  beforeEach(async () => env.STATE.delete("credentials:v1"));

  it("generates a cryptographically random 64-character connection secret", () => {
    const first = generateMcpSecret();
    const second = generateMcpSecret();

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
  });

  it("creates the secret once and stores it encrypted", async () => {
    const store = new EncryptedCredentialStore(
      env.STATE,
      "unit-test-installation-secret",
    );
    const first = await getOrCreateMcpSecret(store);
    const second = await getOrCreateMcpSecret(store);
    const persisted = await env.STATE.get("credentials:v1");

    expect(second).toBe(first);
    expect(persisted).not.toContain(first);
  });
});
