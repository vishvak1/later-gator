import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertOwner } from "../src/adapters/control-repository";
import {
  createAuthorizedInstallation,
  findOwnerInstallationSummary,
  markInstallationReady,
  recordInstallationResource,
  revokeInstallerAuthorization,
  storeInstallerAuthorization,
} from "../src/adapters/installation-repository";
import {
  configureRolloutCampaign,
  recordRolloutOutcome,
} from "../src/adapters/release-repository";
import { updateOwnerRuntime } from "../src/application/updates";
import type { ControlConfig } from "../src/domain/config";
import { encryptInstallerToken } from "../src/security/installer-token-vault";

const ACCOUNT_ID = "a".repeat(32);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const NEW_VERSION = "22222222-2222-4222-8222-222222222222";
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

/** Seeds one supported prior release with every resource needed to reconstruct bindings. */
async function priorInstallation(
  tokenExpiresIn = 3600,
): Promise<{ installationId: string; ownerId: string }> {
  const ownerId = await upsertOwner(env.CONTROL_DB, `update-${crypto.randomUUID()}`, 100);
  const installationId = crypto.randomUUID();
  await createAuthorizedInstallation(env.CONTROL_DB, {
    installationId,
    ownerId,
    accountId: ACCOUNT_ID,
    storageMode: "kv",
    requestedPlanJson: JSON.stringify({ contractVersion: 1, storageMode: "kv" }),
    nowSeconds: 100,
  });
  const resources = [
    { type: "d1" as const, name: "db", id: "33333333-3333-4333-8333-333333333333" },
    { type: "oauth_kv" as const, name: "oauth", id: "oauth-kv-0001" },
    { type: "thumbnail_kv" as const, name: "thumbnails", id: "thumbnail-kv-0001" },
    { type: "vectorize" as const, name: "vectors", id: "vectors" },
    { type: "background_queue" as const, name: "background", id: "background-queue-0001" },
    { type: "thumbnail_queue" as const, name: "thumbnail-jobs", id: "thumbnail-queue-0001" },
    { type: "worker" as const, name: "later-gator-update", id: "later-gator-update" },
  ];
  for (const resource of resources) {
    await recordInstallationResource(env.CONTROL_DB, installationId, resource, 100);
  }
  await markInstallationReady(
    env.CONTROL_DB,
    installationId,
    "https://later-gator-update.owner.workers.dev",
    "0.9.0",
    OLD_VERSION,
    "0".repeat(64),
    0,
    100,
  );
  const encrypted = await encryptInstallerToken(
    ENCRYPTION_KEY,
    ownerId,
    ACCOUNT_ID,
    {
      accessToken: "update-access-token",
      refreshToken: "update-refresh-token",
      expiresIn: tokenExpiresIn,
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
  await configureRolloutCampaign(env.CONTROL_DB, "1.0.0", 100, 10, 100);
  return { installationId, ownerId };
}

/** Mocks the staged-version API, schema migration, and privacy-safe runtime health. */
function updateFetcher(options: {
  failAfterPromotion?: boolean;
  failCandidateHealth?: boolean;
  failDeploymentOnce?: boolean;
  failMigrationOnce?: boolean;
  rejectAuthorization?: boolean;
  revokeRefreshToken?: boolean;
} = {}) {
  let deployment = 0;
  let deploymentFailed = false;
  let migrationFailed = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const ok = (result: unknown, status = 200) => Response.json({ success: true, result }, { status });
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://dash.cloudflare.com",
        authorization_endpoint: "https://dash.cloudflare.com/oauth2/auth",
        token_endpoint: "https://dash.cloudflare.com/oauth2/token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.pathname === "/oauth2/token" && options.revokeRefreshToken === true) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.hostname === "api.cloudflare.com" && options.rejectAuthorization === true) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 401 },
      );
    }
    if (url.hostname.endsWith("workers.dev") && url.pathname === "/health") {
      const staged = request.headers.has("Cloudflare-Workers-Version-Overrides");
      const failed = (options.failAfterPromotion === true && !staged) ||
        (options.failCandidateHealth === true && staged);
      return Response.json({
        contractVersion: 1,
        runtimeRelease: failed ? "0.9.0" : "1.0.0",
        schemaVersion: failed ? 0 : 1,
        status: failed ? "unavailable" : "ready",
        bindingReadiness: failed ? "unavailable" : "ready",
        queueReadiness: failed ? "unavailable" : "ready",
        safeErrorCodes: failed ? ["release_incompatible"] : [],
      });
    }
    if (url.pathname.endsWith("/time_travel/bookmark")) return ok({ bookmark: "bookmark-00000001" });
    if (url.pathname.endsWith("/query") && request.method === "POST") {
      const body: unknown = await request.clone().json();
      const batch = typeof body === "object" && body !== null && "batch" in body
        ? body.batch
        : undefined;
      if (!Array.isArray(batch) || batch.length === 0 ||
        !batch.every((entry) =>
          typeof entry === "object" && entry !== null &&
          typeof (entry as { sql: unknown }).sql === "string" &&
          (entry as { sql: string }).sql.length > 0 &&
          ((entry as { params?: unknown }).params === undefined ||
            Array.isArray((entry as { params: unknown }).params)),
        )) {
        return Response.json(
          { success: false, errors: [{ code: 7400, message: "request body invalid" }] },
          { status: 400 },
        );
      }
      if (options.failMigrationOnce === true && !migrationFailed) {
        migrationFailed = true;
        return new Response(null, { status: 503 });
      }
      return ok(batch.map(() => ({ success: true })));
    }
    if (url.pathname.endsWith("/assets-upload-session")) {
      return ok({ jwt: "asset-upload-token-000000000000", buckets: [] });
    }
    if (url.pathname.endsWith("/versions") && request.method === "POST") {
      return ok({ id: NEW_VERSION });
    }
    if (url.pathname.endsWith("/deployments") && request.method === "POST") {
      if (options.failDeploymentOnce === true && !deploymentFailed) {
        deploymentFailed = true;
        return new Response(null, { status: 503 });
      }
      deployment += 1;
      return ok({ id: `${String(deployment).padStart(8, "0")}-0000-4000-8000-000000000000` });
    }
    return new Response(null, { status: 404 });
  });
}

beforeEach(async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM rollout_campaigns"),
    env.CONTROL_DB.prepare("DELETE FROM installations"),
    env.CONTROL_DB.prepare("DELETE FROM installer_authorizations"),
    env.CONTROL_DB.prepare("DELETE FROM owners"),
  ]);
});

describe("managed runtime updates", () => {
  it("migrates, smoke-tests, promotes, and records one immutable release", async () => {
    const { installationId, ownerId } = await priorInstallation();
    const fetcher = updateFetcher();
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      "1.0.0",
      fetcher,
      200,
    )).resolves.toEqual({ status: "updated", release: "1.0.0" });
    expect(await env.CONTROL_DB.prepare(
      "SELECT installed_release, current_version_id, previous_version_id FROM installations WHERE id = ?",
    ).bind(installationId).first()).toEqual({
      installed_release: "1.0.0",
      current_version_id: NEW_VERSION,
      previous_version_id: OLD_VERSION,
    });
    expect(await env.CONTROL_DB.prepare(
      "SELECT state, time_travel_bookmark FROM runtime_release_history WHERE installation_id = ? AND release = '1.0.0'",
    ).bind(installationId).first()).toEqual({ state: "promoted", time_travel_bookmark: "bookmark-00000001" });
  });

  it("rolls back code after a post-promotion health failure when migrations are expand-compatible", async () => {
    const { ownerId } = await priorInstallation();
    const fetcher = updateFetcher({ failAfterPromotion: true });
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      "1.0.0",
      fetcher,
      200,
    )).resolves.toEqual({ status: "rolled_back", release: "1.0.0" });
    const deployments = fetcher.mock.calls.filter(([input, init]) =>
      new URL(new Request(input, init).url).pathname.endsWith("/deployments")
    );
    expect(deployments).toHaveLength(3);
  });

  it("does not promote a candidate that fails its version-specific health check", async () => {
    const { ownerId } = await priorInstallation();
    const fetcher = updateFetcher({ failCandidateHealth: true });
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      "1.0.0",
      fetcher,
      200,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    expect((await findOwnerInstallationSummary(
      env.CONTROL_DB,
      ownerId,
    ))?.authorizationActive).toBe(true);
    const deployments = fetcher.mock.calls.filter(([input, init]) =>
      new URL(new Request(input, init).url).pathname.endsWith("/deployments")
    );
    expect(deployments).toHaveLength(1);
  });

  it("marks installer authorization inactive after a definitive Cloudflare API rejection", async () => {
    const { ownerId } = await priorInstallation();
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      "1.0.0",
      updateFetcher({ rejectAuthorization: true }),
      200,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      authorizationActive: false,
      safeErrorCode: null,
      updateStatus: "failed",
    });
    expect(await env.CONTROL_DB.prepare(
      `SELECT safe_error_code FROM runtime_release_history
        WHERE installation_id = (SELECT id FROM installations WHERE owner_id = ?)
          AND release = '1.0.0'`,
    ).bind(ownerId).first()).toEqual({ safe_error_code: "installer_authorization_revoked" });
  });

  it("marks installer authorization inactive when Cloudflare revokes the refresh token", async () => {
    const { ownerId } = await priorInstallation(60);
    const fetcher = updateFetcher({ revokeRefreshToken: true });
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      "1.0.0",
      fetcher,
      200,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    expect((await findOwnerInstallationSummary(
      env.CONTROL_DB,
      ownerId,
    ))?.authorizationActive).toBe(false);
    expect(fetcher.mock.calls.some(([input, init]) =>
      new URL(new Request(input, init).url).hostname === "api.cloudflare.com"
    )).toBe(false);
  });

  it("retries interrupted schema and deployment operations idempotently", async () => {
    const migration = await priorInstallation();
    const migrationFetcher = updateFetcher({ failMigrationOnce: true });
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      migration.ownerId,
      "1.0.0",
      migrationFetcher,
      200,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    expect((await findOwnerInstallationSummary(
      env.CONTROL_DB,
      migration.ownerId,
    ))?.authorizationActive).toBe(true);
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      migration.ownerId,
      "1.0.0",
      migrationFetcher,
      201,
    )).resolves.toEqual({ status: "updated", release: "1.0.0" });

    const deployment = await priorInstallation();
    const deploymentFetcher = updateFetcher({ failDeploymentOnce: true });
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      deployment.ownerId,
      "1.0.0",
      deploymentFetcher,
      202,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      deployment.ownerId,
      "1.0.0",
      deploymentFetcher,
      203,
    )).resolves.toEqual({ status: "updated", release: "1.0.0" });
  });

  it("recovers cleanly when release artifacts are temporarily unavailable", async () => {
    const { ownerId } = await priorInstallation();
    let unavailable = true;
    const artifacts: Fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (unavailable) {
          unavailable = false;
          return new Response(null, { status: 503 });
        }
        return env.RELEASE_ARTIFACTS.fetch(input, init);
      },
      connect: env.RELEASE_ARTIFACTS.connect.bind(env.RELEASE_ARTIFACTS),
    };
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      artifacts,
      config,
      ownerId,
      "1.0.0",
      updateFetcher(),
      200,
    )).rejects.toThrow("release_unavailable");
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      artifacts,
      config,
      ownerId,
      "1.0.0",
      updateFetcher(),
      201,
    )).resolves.toEqual({ status: "updated", release: "1.0.0" });
  });

  it("refuses an unattended contract migration before touching the personal account", async () => {
    const { ownerId } = await priorInstallation();
    const artifacts = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/artifact.json")) {
          const response = await env.RELEASE_ARTIFACTS.fetch(request);
          const artifact: {
            maximumSchemaVersion: number;
            migrations: Record<string, unknown>[];
          } & Record<string, unknown> = await response.json();
          const base = artifact.migrations[0];
          if (base === undefined) throw new Error("base_migration_missing");
          return Response.json({
            ...artifact,
            maximumSchemaVersion: 2,
            migrations: [
              base,
              {
                ...base,
                id: "contract-schema",
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                phase: "contract",
              },
            ],
          });
        }
        return env.RELEASE_ARTIFACTS.fetch(request);
      },
    } as unknown as Fetcher;
    const cloudflare = updateFetcher();
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      artifacts,
      config,
      ownerId,
      "1.0.0",
      cloudflare,
      200,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it("skips a completed migration on retry and blocks updates after authorization revocation", async () => {
    const { installationId, ownerId } = await priorInstallation();
    const artifactResponse = await env.RELEASE_ARTIFACTS.fetch(
      "https://release-artifacts.invalid/runtime/1.0.0/artifact.json",
    );
    const artifact: { migrations: { sha256: string }[] } = await artifactResponse.json();
    const migration = artifact.migrations[0];
    if (migration === undefined) throw new Error("release_migration_missing");
    await env.CONTROL_DB.prepare(
      `INSERT OR REPLACE INTO control_schema_migrations (
         installation_id, migration_id, checksum, from_schema_version, to_schema_version,
         phase, time_travel_bookmark, state, updated_at
       ) VALUES (?, 'base-schema', ?, 0, 1, 'expand', 'bookmark-old', 'complete', 150)`,
    ).bind(installationId, migration.sha256).run();
    const fetcher = updateFetcher();
    await updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      "1.0.0",
      fetcher,
      200,
    );
    expect(fetcher.mock.calls.some(([input, init]) =>
      new URL(new Request(input, init).url).pathname.endsWith("/query")
    )).toBe(false);

    const next = await priorInstallation();
    await revokeInstallerAuthorization(env.CONTROL_DB, next.ownerId, 200);
    const blocked = updateFetcher();
    await expect(updateOwnerRuntime(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      next.ownerId,
      "1.0.0",
      blocked,
      201,
    )).resolves.toEqual({ status: "failed", release: "1.0.0" });
    expect(blocked).not.toHaveBeenCalled();
  });

  it("automatically pauses a cohort after five failures reach its threshold", async () => {
    await configureRolloutCampaign(env.CONTROL_DB, "1.0.0", 10, 20, 100);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordRolloutOutcome(env.CONTROL_DB, "1.0.0", true, 101 + attempt);
    }
    expect(await env.CONTROL_DB.prepare(
      "SELECT state, attempted_count, failure_count FROM rollout_campaigns WHERE release = '1.0.0'",
    ).first()).toEqual({ state: "paused", attempted_count: 5, failure_count: 5 });
  });
});
