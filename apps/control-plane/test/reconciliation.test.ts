import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertOwner } from "../src/adapters/control-repository";
import {
  createAuthorizedInstallation,
  findOwnerInstallationSummary,
  markInstallationReady,
  recordInstallationResource,
  storeInstallerAuthorization,
} from "../src/adapters/installation-repository";
import { reconcileOwnerRuntime } from "../src/application/reconciliation";
import type { ControlConfig } from "../src/domain/config";
import { encryptInstallerToken } from "../src/security/installer-token-vault";

const ACCOUNT_ID = "b".repeat(32);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config: ControlConfig = {
  chromeExtensionIds: [],
  environment: "test",
  publicOrigin: "https://latergator.test",
  oidcIssuer: "https://dash.cloudflare.com",
  accessTeamDomain: "https://later-gator-test.cloudflareaccess.com",
  accessAudience: "a".repeat(64),
  sessionTtlSeconds: 43_200,
  installerClientId: "test-client",
  installerClientSecret: "test-secret",
  installerTokenEncryptionKey: ENCRYPTION_KEY,
};

/** Seeds one ready installation whose Worker can be reconciled through Cloudflare metadata. */
async function readyInstallation(): Promise<string> {
  const ownerId = await upsertOwner(env.CONTROL_DB, `reconcile-${crypto.randomUUID()}`, 100);
  const installationId = crypto.randomUUID();
  await createAuthorizedInstallation(env.CONTROL_DB, {
    installationId,
    ownerId,
    accountId: ACCOUNT_ID,
    storageMode: "kv",
    requestedPlanJson: "{}",
    nowSeconds: 100,
  });
  await recordInstallationResource(env.CONTROL_DB, installationId, {
    type: "worker",
    id: "later-gator",
    name: "later-gator",
  }, 100);
  await markInstallationReady(
    env.CONTROL_DB,
    installationId,
    "https://later-gator.owner.workers.dev",
    "1.0.0",
    crypto.randomUUID(),
    "a".repeat(64),
    1,
    100,
  );
  const encrypted = await encryptInstallerToken(
    ENCRYPTION_KEY,
    ownerId,
    ACCOUNT_ID,
    {
      accessToken: "installer-access-token",
      refreshToken: "installer-refresh-token",
      expiresIn: 3600,
      grantedScopes: ["workers-scripts.write"],
    },
    100,
  );
  await storeInstallerAuthorization(env.CONTROL_DB, {
    ownerId,
    accountId: ACCOUNT_ID,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    grantedScopesJson: JSON.stringify(["workers-scripts.write"]),
    expiresAt: encrypted.expiresAt,
    updatedAt: 100,
  });
  return ownerId;
}

beforeEach(async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM installations"),
    env.CONTROL_DB.prepare("DELETE FROM installer_authorizations"),
    env.CONTROL_DB.prepare("DELETE FROM owners"),
  ]);
});

describe("runtime Worker reconciliation", () => {
  it("disables the stale website link after an out-of-band Worker deletion", async () => {
    const ownerId = await readyInstallation();
    const requestedUrls: string[] = [];
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      requestedUrls.push(new Request(input).url);
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    await expect(reconcileOwnerRuntime(
      env.CONTROL_DB,
      config,
      ownerId,
      fetcher,
      200,
    )).resolves.toBe("missing");
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      status: "ready",
      runtimeHealthStatus: "unavailable",
      safeErrorCode: "runtime_worker_missing",
    });
    expect(requestedUrls[0]).toContain("/workers/scripts/later-gator/settings");
  });

  it("restores availability only after Cloudflare confirms the Worker exists", async () => {
    const ownerId = await readyInstallation();
    await reconcileOwnerRuntime(
      env.CONTROL_DB,
      config,
      ownerId,
      () => Promise.resolve(new Response(null, { status: 404 })),
      200,
    );
    await expect(reconcileOwnerRuntime(
      env.CONTROL_DB,
      config,
      ownerId,
      () => Promise.resolve(Response.json({ success: true, result: {} })),
      201,
    )).resolves.toBe("available");
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      runtimeHealthStatus: "ready",
      safeErrorCode: null,
    });
  });

  it("does not claim deletion during a transient Cloudflare failure", async () => {
    const ownerId = await readyInstallation();
    await expect(reconcileOwnerRuntime(
      env.CONTROL_DB,
      config,
      ownerId,
      () => Promise.resolve(new Response(null, { status: 503 })),
      200,
    )).resolves.toBe("unchecked");
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      runtimeHealthStatus: "ready",
      safeErrorCode: null,
    });
  });
});
