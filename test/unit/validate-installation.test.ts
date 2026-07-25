import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstallationValidationError,
  validateInstallation,
} from "../../src/application/validate-installation";
import { EncryptedCredentialStore } from "../../src/adapters/encrypted-credential-store";
import { EmailConfigStore } from "../../src/adapters/email-config-store";

const installationSecret = "local-test-installation-secret";

describe("validateInstallation", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("credentials:v1"),
      env.STATE.delete("email-config:v1"),
      env.STATE.delete("installation:v1"),
      env.STATE.delete("provider-config:v1"),
    ]);
  });

  it("validates bindings, Raindrop identity, provider, and exact email state without mutation", async () => {
    await new EncryptedCredentialStore(env.STATE, installationSecret).set(
      "raindrop",
      "redacted-raindrop-token",
    );
    await new EmailConfigStore(env.STATE).markUnavailable();
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          result: true,
          user: { _id: 42, fullName: "Test User" },
        }),
      ),
    );
    const testProvider = vi.fn(() => Promise.resolve());

    const state = await validateInstallation(env, installationSecret, {
      request,
      testProvider,
      assertRequiredBindings: () => undefined,
    });

    expect(state).toMatchObject({
      raindropUserId: 42,
      bindingsValid: true,
      providerValid: true,
      emailStatus: "unavailable",
    });
    expect(testProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "workers-ai" }),
      null,
    );
    expect(await env.STATE.get("installation:v1")).not.toBeNull();
    const validationKeys = await env.STATE.list({ prefix: "validation:" });
    expect(validationKeys.keys).toHaveLength(0);
  });

  it("fails closed before provider validation when the Raindrop token is missing", async () => {
    const testProvider = vi.fn(() => Promise.resolve());
    await expect(
      validateInstallation(env, installationSecret, {
        testProvider,
        assertRequiredBindings: () => undefined,
      }),
    ).rejects.toBeInstanceOf(InstallationValidationError);
    expect(testProvider).not.toHaveBeenCalled();
    await expect(env.STATE.get("installation:v1")).resolves.toBeNull();
  });

  it.each([
    [401, "Raindrop rejected the saved token (HTTP 401)."],
    [403, "Raindrop rejected the saved token (HTTP 403)."],
    [429, "Raindrop is temporarily limiting requests (HTTP 429)."],
    [503, "Raindrop is temporarily unavailable (HTTP 503)."],
    [400, "Raindrop rejected Later Gator's connection request (HTTP 400)."],
  ])(
    "reports a safe Raindrop diagnostic for HTTP %i without running the provider test",
    async (status, expectedMessage) => {
      await new EncryptedCredentialStore(env.STATE, installationSecret).set(
        "raindrop",
        "redacted-raindrop-token",
      );
      const testProvider = vi.fn(() => Promise.resolve());
      const request = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status })),
      );

      await expect(
        validateInstallation(env, installationSecret, {
          request,
          testProvider,
          assertRequiredBindings: () => undefined,
        }),
      ).rejects.toThrow(expectedMessage);
      expect(testProvider).not.toHaveBeenCalled();
      await expect(env.STATE.get("installation:v1")).resolves.toBeNull();
    },
  );

  it("reports an unexpected Raindrop reply without including response content", async () => {
    await new EncryptedCredentialStore(env.STATE, installationSecret).set(
      "raindrop",
      "redacted-raindrop-token",
    );
    const responseContent = "private-response-content";
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ result: true, user: { unexpected: responseContent } }),
      ),
    );

    let failure: unknown;
    try {
      await validateInstallation(env, installationSecret, {
        request,
        testProvider: () => Promise.resolve(),
        assertRequiredBindings: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InstallationValidationError);
    expect((failure as Error).message).toContain(
      "Later Gator could not understand the response",
    );
    expect((failure as Error).message).not.toContain(responseContent);
  });

  it("distinguishes a stored-token decryption problem from a rejected token", async () => {
    await new EncryptedCredentialStore(env.STATE, "different-secret").set(
      "raindrop",
      "redacted-raindrop-token",
    );

    await expect(
      validateInstallation(env, installationSecret, {
        testProvider: () => Promise.resolve(),
        assertRequiredBindings: () => undefined,
      }),
    ).rejects.toThrow("could not open the securely saved Raindrop token");
  });
});
