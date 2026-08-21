import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadProviderCredentialForWorker,
  saveProviderCredential,
} from "../src/security/credential-vault";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instance provider credential vault", () => {
  it("stores one AEAD representation and decrypts it without a control-plane call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await saveProviderCredential(env, "openai", "sk-test-provider-secret");
    expect(await loadProviderCredentialForWorker(env, "openai")).toBe(
      "sk-test-provider-secret",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const columns = await env.DB
      .prepare("PRAGMA table_info(encrypted_credentials)")
      .all<{ name: string }>();
    const names = columns.results.map((column) => column.name);
    expect(names).toContain("ciphertext");
    expect(names).not.toContain("service_ciphertext");
    expect(names).not.toContain("service_nonce");
    const row = await env.DB
      .prepare(
        `SELECT credential_type, ciphertext, nonce, schema_version
           FROM encrypted_credentials
          WHERE credential_type = 'openai'`,
      )
      .first<{
        credential_type: string;
        ciphertext: string;
        nonce: string;
        schema_version: number;
      }>();
    expect(row).toMatchObject({ credential_type: "openai", schema_version: 1 });
    expect(row?.ciphertext).not.toContain("sk-test-provider-secret");
  });

  it("binds ciphertext to its provider type with authenticated associated data", async () => {
    await saveProviderCredential(env, "openai", "sk-bound-to-openai");
    const row = await env.DB
      .prepare("SELECT ciphertext, nonce FROM encrypted_credentials WHERE credential_type = 'openai'")
      .first<{ ciphertext: string; nonce: string }>();
    if (row === null) throw new Error("Missing encrypted provider fixture");
    const now = new Date().toISOString();
    await env.DB
      .prepare(
        `INSERT INTO encrypted_credentials (
          id, credential_type, ciphertext, nonce, schema_version, created_at, updated_at
        ) VALUES ('provider_anthropic', 'anthropic', ?, ?, 1, ?, ?)`,
      )
      .bind(row.ciphertext, row.nonce, now, now)
      .run();
    await expect(loadProviderCredentialForWorker(env, "anthropic")).rejects.toBeInstanceOf(Error);
  });
});
