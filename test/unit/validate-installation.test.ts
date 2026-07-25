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
});
