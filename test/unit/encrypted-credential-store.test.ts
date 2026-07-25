import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CredentialDecryptionError,
  EncryptedCredentialStore,
} from "../../src/adapters/encrypted-credential-store";

const STATE_KEY = "credentials:v1";
const ROOT_SECRET = "unit-test-installation-secret";

describe("EncryptedCredentialStore", () => {
  beforeEach(async () => env.STATE.delete(STATE_KEY));

  it("encrypts credentials at rest and decrypts them on demand", async () => {
    const store = new EncryptedCredentialStore(env.STATE, ROOT_SECRET);
    await store.set("openai", "sk-test-plaintext-value");

    const persisted = await env.STATE.get(STATE_KEY);
    expect(persisted).not.toBeNull();
    expect(persisted).not.toContain("sk-test-plaintext-value");
    await expect(store.get("openai")).resolves.toBe("sk-test-plaintext-value");
  });

  it("uses a fresh nonce when a credential is replaced", async () => {
    const store = new EncryptedCredentialStore(env.STATE, ROOT_SECRET);
    await store.set("anthropic", "first-test-value");
    const first = await env.STATE.get(STATE_KEY, "json");

    await store.set("anthropic", "second-test-value");
    const second = await env.STATE.get(STATE_KEY, "json");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });

  it("fails closed after the root installation secret changes", async () => {
    const store = new EncryptedCredentialStore(env.STATE, ROOT_SECRET);
    await store.set("raindrop", "raindrop-test-token");

    const rotatedStore = new EncryptedCredentialStore(env.STATE, "different-root-secret");
    await expect(rotatedStore.get("raindrop")).rejects.toBeInstanceOf(
      CredentialDecryptionError,
    );
  });

  it("removes only the selected external provider credential", async () => {
    const store = new EncryptedCredentialStore(env.STATE, ROOT_SECRET);
    await store.set("openai", "openai-test-key");
    await store.set("anthropic", "anthropic-test-key");

    await store.remove("openai");

    await expect(store.get("openai")).resolves.toBeNull();
    await expect(store.get("anthropic")).resolves.toBe("anthropic-test-key");
    await expect(store.getStatus()).resolves.toMatchObject({
      openai: { configured: false },
      anthropic: { configured: true },
    });
  });
});
