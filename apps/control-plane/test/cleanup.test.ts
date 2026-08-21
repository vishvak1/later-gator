import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertOwner } from "../src/adapters/control-repository";
import {
  createAuthorizedInstallation,
  recordInstallationResource,
  storeInstallerAuthorization,
} from "../src/adapters/installation-repository";
import { cleanupOwnerInstallation } from "../src/application/cleanup";
import type { ControlConfig } from "../src/domain/config";
import { encryptInstallerToken } from "../src/security/installer-token-vault";

const ACCOUNT_ID = "a".repeat(32);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config: ControlConfig = {
  chromeExtensionIds: [],
  environment: "test",
  publicOrigin: "https://latergator.test",
  oidcIssuer: "https://dash.cloudflare.com",
  sessionTtlSeconds: 43_200,
  identityClientId: "test-identity-client",
  identityClientSecret: "test-identity-secret",
  installerTokenEncryptionKey: ENCRYPTION_KEY,
};

/** Seeds one failed installation with two resources eligible for cleanup. */
async function failedInstallation(): Promise<{ installationId: string; ownerId: string }> {
  const ownerId = await upsertOwner(env.CONTROL_DB, `cleanup-${crypto.randomUUID()}`, 100);
  const installationId = crypto.randomUUID();
  await createAuthorizedInstallation(env.CONTROL_DB, {
    installationId,
    ownerId,
    accountId: ACCOUNT_ID,
    storageMode: "kv",
    requestedPlanJson: JSON.stringify({ contractVersion: 1, storageMode: "kv" }),
    nowSeconds: 100,
  });
  await recordInstallationResource(env.CONTROL_DB, installationId, {
    type: "worker", name: "later-gator-test", id: "later-gator-test",
  }, 100);
  await recordInstallationResource(env.CONTROL_DB, installationId, {
    type: "d1", name: "later-gator-test-db", id: "11111111-1111-4111-8111-111111111111",
  }, 100);
  await env.CONTROL_DB.prepare(
    "UPDATE installations SET status = 'failed' WHERE id = ?",
  ).bind(installationId).run();
  const encrypted = await encryptInstallerToken(
    ENCRYPTION_KEY,
    ownerId,
    ACCOUNT_ID,
    {
      accessToken: "cleanup-access-token",
      refreshToken: "cleanup-refresh-token",
      expiresIn: 3600,
      grantedScopes: ["d1.write", "workers-scripts.write"],
    },
    100,
  );
  await storeInstallerAuthorization(env.CONTROL_DB, {
    ownerId,
    accountId: ACCOUNT_ID,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    grantedScopesJson: JSON.stringify(["d1.write", "workers-scripts.write"]),
    expiresAt: encrypted.expiresAt,
    updatedAt: 100,
  });
  return { installationId, ownerId };
}

beforeEach(async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM installations"),
    env.CONTROL_DB.prepare("DELETE FROM installer_authorizations"),
    env.CONTROL_DB.prepare("DELETE FROM owners"),
  ]);
});

describe("explicit compensating cleanup", () => {
  it("records partial deletion and resumes without deleting the same resource twice", async () => {
    const { installationId, ownerId } = await failedInstallation();
    const first = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      return Promise.resolve(request.url.includes("/workers/scripts/")
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 503 }));
    });
    await expect(cleanupOwnerInstallation(
      env.CONTROL_DB,
      config,
      ownerId,
      first,
      200,
    )).rejects.toThrow("cloudflare_unavailable");
    expect(await env.CONTROL_DB.prepare(
      "SELECT status FROM installation_resources WHERE installation_id = ? AND resource_type = 'worker'",
    ).bind(installationId).first()).toEqual({ status: "deleted" });

    const second = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    await cleanupOwnerInstallation(env.CONTROL_DB, config, ownerId, second, 201);
    expect(second).toHaveBeenCalledTimes(1);
    expect(await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM installations WHERE id = ?",
    ).bind(installationId).first()).toEqual({ count: 0 });
  });

  it("refuses cleanup of a ready personal installation", async () => {
    const { installationId, ownerId } = await failedInstallation();
    await env.CONTROL_DB.prepare("UPDATE installations SET status = 'ready' WHERE id = ?")
      .bind(installationId).run();
    await expect(cleanupOwnerInstallation(env.CONTROL_DB, config, ownerId, vi.fn(), 200))
      .rejects.toMatchObject({ code: "bad_request", status: 400 });
  });
});
