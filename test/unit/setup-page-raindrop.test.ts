import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedCredentialStore } from "../../src/adapters/encrypted-credential-store";
import { readRaindropSnapshot } from "../../src/routes/setup-page";

const installationSecret = "local-test-installation-secret";

describe("setup-page Raindrop snapshot", () => {
  beforeEach(async () => {
    await env.STATE.delete("credentials:v1");
  });

  it("keeps the account connected when only the bookmark-count request fails", async () => {
    const store = new EncryptedCredentialStore(env.STATE, installationSecret);
    await store.set("raindrop", "redacted-raindrop-token");
    const request = vi.fn<typeof fetch>((input) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      if (url.endsWith("/user")) {
        return Promise.resolve(
          Response.json({
            result: true,
            user: { _id: 42, fullName: "Test User" },
          }),
        );
      }
      return Promise.reject(new TypeError("simulated network failure"));
    });

    const snapshot = await readRaindropSnapshot(store, request);
    expect(snapshot.status).toBe("connected");
    if (snapshot.status !== "connected") throw new Error("Expected connected snapshot");
    expect(snapshot).toMatchObject({
      id: 42,
      name: "Test User",
      pending: null,
    });
    expect(snapshot.pendingDiagnostic?.code).toBe("unreachable");
  });

  it("reports the account itself as disconnected when identity lookup fails", async () => {
    const store = new EncryptedCredentialStore(env.STATE, installationSecret);
    await store.set("raindrop", "redacted-raindrop-token");
    const request = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("simulated network failure")),
    );

    const snapshot = await readRaindropSnapshot(store, request);
    expect(snapshot.status).toBe("error");
    if (snapshot.status !== "error") throw new Error("Expected error snapshot");
    expect(snapshot.diagnostic.code).toBe("unreachable");
  });
});
