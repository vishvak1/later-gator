import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertOwner } from "../src/adapters/control-repository";
import {
  createAuthorizedInstallation,
  findOwnerInstallationSummary,
  storeInstallerAuthorization,
} from "../src/adapters/installation-repository";
import { provisionOwnerInstallation } from "../src/application/provisioning";
import type { ControlConfig } from "../src/domain/config";
import { encryptInstallerToken } from "../src/security/installer-token-vault";

const ACCOUNT_ID = "a".repeat(32);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const INITIAL_DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const INITIAL_VERSION = "33333333-3333-4333-8333-333333333333";
const config: ControlConfig = {
  chromeExtensionIds: [],
  environment: "test",
  publicOrigin: "https://latergator.test",
  oidcIssuer: "https://dash.cloudflare.com",
  accessTeamDomain: "https://later-gator-test.cloudflareaccess.com",
  accessAudience: "a".repeat(64),
  sessionTtlSeconds: 43_200,
  installerClientId: "test-identity-client",
  installerClientSecret: "test-identity-secret",
  installerTokenEncryptionKey: ENCRYPTION_KEY,
};

/** Creates bounded Cloudflare API responses for a complete KV installation. */
function provisioningFetcher(options: {
  failR2?: boolean;
  failVectorizeOnce?: boolean;
  healthWorkerFetchBlocked?: boolean;
  invalidWorkerVersion?: boolean;
  healthUnavailableCount?: number;
  workerMissing?: boolean;
} = {}) {
  const createdKv = new Map<string, string>();
  const queues = new Map<string, string>();
  let vectorizeFailed = false;
  let healthChecks = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const ok = (result: unknown, status = 200) => Response.json({ success: true, result }, { status });
    if (url.hostname.endsWith("workers.dev") && url.pathname === "/health") {
      healthChecks += 1;
      if (options.healthWorkerFetchBlocked === true) {
        return new Response("error code: 1042\n", { status: 404 });
      }
      if ((options.healthUnavailableCount ?? 0) >= healthChecks) {
        return new Response(null, { status: 503 });
      }
      return Response.json({
        contractVersion: 1,
        runtimeRelease: "1.0.0",
        schemaVersion: 1,
        status: "ready",
        bindingReadiness: "ready",
        queueReadiness: "ready",
        safeErrorCodes: [],
      });
    }
    if (url.pathname.endsWith("/d1/database") && request.method === "GET") return ok([]);
    if (url.pathname.endsWith("/d1/database") && request.method === "POST") {
      const body: { name: string } = await request.clone().json();
      return ok({ uuid: "11111111-1111-4111-8111-111111111111", name: body.name }, 201);
    }
    if (url.pathname.endsWith("/storage/kv/namespaces") && request.method === "GET") {
      return ok([...createdKv].map(([title, id]) => ({ id, title })));
    }
    if (url.pathname.endsWith("/storage/kv/namespaces") && request.method === "POST") {
      const body: { title: string } = await request.clone().json();
      const id = body.title.includes("oauth") ? "oauth-kv-namespace-0001" : "thumbnail-kv-namespace-0001";
      createdKv.set(body.title, id);
      return ok({ id, title: body.title });
    }
    if (url.pathname.endsWith("/r2/buckets") && request.method === "GET") {
      if (options.failR2 === true) return new Response(null, { status: 403 });
      return ok({ buckets: [] });
    }
    if (url.pathname.endsWith("/r2/buckets") && request.method === "POST") {
      const body: { name: string } = await request.clone().json();
      return ok({ name: body.name }, 201);
    }
    if (url.pathname.endsWith("/vectorize/v2/indexes") && request.method === "GET") return ok([]);
    if (url.pathname.endsWith("/vectorize/v2/indexes") && request.method === "POST") {
      if (options.failVectorizeOnce === true && !vectorizeFailed) {
        vectorizeFailed = true;
        return new Response(null, { status: 503 });
      }
      const body: { name: string; config: unknown } = await request.clone().json();
      return ok({ name: body.name, config: body.config }, 201);
    }
    if (url.pathname.endsWith("/queues") && request.method === "GET") {
      return ok({ queues: [...queues].map(([queue_name, queue_id]) => ({ queue_name, queue_id })) });
    }
    if (url.pathname.endsWith("/queues") && request.method === "POST") {
      const body: { queue_name: string } = await request.clone().json();
      const id = body.queue_name.endsWith("background")
        ? "background-queue-0001"
        : "thumbnail-queue-0001";
      queues.set(body.queue_name, id);
      return ok({ queue_id: id, queue_name: body.queue_name }, 201);
    }
    if (/\/queues\/[^/]+\/consumers$/u.test(url.pathname) && request.method === "GET") return ok([]);
    if (/\/queues\/[^/]+\/consumers$/u.test(url.pathname) && request.method === "POST") {
      const body: { script_name: string } = await request.clone().json();
      return ok({ consumer_id: "consumer-0001", script_name: body.script_name, type: "worker" });
    }
    if (url.pathname.endsWith("/workers/subdomain")) return ok({ subdomain: "owner-subdomain" });
    if (url.pathname.endsWith("/assets-upload-session")) {
      return ok({ jwt: "asset-upload-token-000000000000", buckets: [] });
    }
    if (/\/workers\/scripts\/[^/]+$/u.test(url.pathname) && request.method === "PUT") {
      expect(request.headers.get("authorization")).toBe("Bearer installer-access-token");
      return options.invalidWorkerVersion === true
        ? ok({ id: "later-gator-script-name" })
        : ok({ deployment_id: INITIAL_VERSION.replaceAll("-", "") });
    }
    if (url.pathname.endsWith("/settings") && request.method === "GET") {
      return options.workerMissing === true ? new Response(null, { status: 404 }) : ok({});
    }
    if (url.pathname.endsWith("/deployments") && request.method === "GET") {
      return ok({
        deployments: [{
          id: INITIAL_DEPLOYMENT,
          versions: [{ percentage: 100, version_id: INITIAL_VERSION }],
        }],
      });
    }
    if (url.pathname.endsWith("/time_travel/bookmark")) return ok({ bookmark: "bookmark-initial-0001" });
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
      return ok(batch.map(() => ({ success: true })));
    }
    if (url.pathname.endsWith("/subdomain") && request.method === "POST") {
      return ok({ enabled: true, previews_enabled: false });
    }
    return new Response(null, { status: 404 });
  });
}

/** Seeds one encrypted, renewable installer authorization and immutable plan. */
async function authorizedInstallation(storageMode: "kv" | "r2") {
  const ownerId = await upsertOwner(env.CONTROL_DB, `subject-${crypto.randomUUID()}`, 100);
  const installationId = crypto.randomUUID();
  await createAuthorizedInstallation(env.CONTROL_DB, {
    installationId,
    ownerId,
    accountId: ACCOUNT_ID,
    storageMode,
    requestedPlanJson: JSON.stringify({ contractVersion: 1, storageMode }),
    nowSeconds: 100,
  });
  const encrypted = await encryptInstallerToken(
    ENCRYPTION_KEY,
    ownerId,
    ACCOUNT_ID,
    {
      accessToken: "installer-access-token",
      refreshToken: "installer-refresh-token",
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
    env.CONTROL_DB.prepare("DELETE FROM rollout_campaigns"),
    env.CONTROL_DB.prepare("DELETE FROM installations"),
    env.CONTROL_DB.prepare("DELETE FROM installer_authorizations"),
    env.CONTROL_DB.prepare("DELETE FROM owners"),
  ]);
});

describe("resumable OAuth provisioning", () => {
  it("provisions every KV resource once and marks ready only after safe health", async () => {
    const { installationId, ownerId } = await authorizedInstallation("kv");
    const fetcher = provisioningFetcher();
    const outcome = await provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      200,
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.workerOrigin).toBe(
      "https://later-gator.owner-subdomain.workers.dev",
    );
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      status: "ready",
      installedRelease: "1.0.0",
      safeErrorCode: null,
    });
    expect(await env.CONTROL_DB.prepare(
      "SELECT resource_id FROM provisioning_steps WHERE installation_id = ? AND step_code = 'worker_upload'",
    ).bind(installationId).first()).toEqual({ resource_id: INITIAL_VERSION });
    expect(fetcher.mock.calls.filter(([input, init]) => {
      const request = new Request(input, init);
      return request.method === "GET" && /\/deployments\/[^/]+$/u.test(new URL(request.url).pathname);
    })).toHaveLength(0);
    expect(await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM provisioning_steps WHERE installation_id = ? AND status = 'complete'",
    ).bind(installationId).first()).toEqual({ count: 12 });
    expect(await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM installation_resources WHERE installation_id = ?",
    ).bind(installationId).first()).toEqual({ count: 7 });
    expect((await env.CONTROL_DB.prepare(
      "SELECT resource_name FROM installation_resources WHERE installation_id = ? ORDER BY resource_name",
    ).bind(installationId).all<{ resource_name: string }>()).results.map((row) => row.resource_name))
      .toEqual([
        "later-gator",
        "later-gator-background",
        "later-gator-db",
        "later-gator-oauth",
        "later-gator-thumbnail-jobs",
        "later-gator-thumbnails",
        "later-gator-vectors",
      ]);
    expect(await env.CONTROL_DB.prepare(
      "SELECT state, schema_version, version_id FROM runtime_release_history WHERE installation_id = ?",
    ).bind(installationId).first()).toEqual({
      state: "promoted",
      schema_version: 1,
      version_id: INITIAL_VERSION,
    });
    expect(await env.CONTROL_DB.prepare(
      "SELECT state, time_travel_bookmark FROM control_schema_migrations WHERE installation_id = ?",
    ).bind(installationId).first()).toEqual({
      state: "complete",
      time_travel_bookmark: "bookmark-initial-0001",
    });
    const createCalls = fetcher.mock.calls.length;
    expect(await provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      201,
    )).toMatchObject({ status: "ready" });
    expect(fetcher).toHaveBeenCalledTimes(createCalls);
    const schemaQuery = fetcher.mock.calls.find(([input, init]) => {
      const request = new Request(input, init);
      return request.method === "POST" && new URL(request.url).pathname.endsWith("/query");
    });
    expect(schemaQuery).toBeDefined();
    if (schemaQuery === undefined) throw new Error("schema query request missing");
    const queryBody: { batch: { sql: string }[]; sql?: string } =
      await new Request(...schemaQuery).clone().json();
    expect(Array.isArray(queryBody.batch)).toBe(true);
    expect(queryBody.batch.length).toBeGreaterThan(0);
    expect(queryBody.batch.every(({ sql }) => typeof sql === "string" && sql.length > 0))
      .toBe(true);
    expect(queryBody.sql).toBeUndefined();
  });

  it("pauses R2 checkout without losing completed steps and resumes idempotently", async () => {
    const { installationId, ownerId } = await authorizedInstallation("r2");
    expect(await provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      provisioningFetcher({ failR2: true }),
      200,
    )).toEqual({ status: "waiting_for_r2" });
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      status: "waiting_for_r2",
      safeErrorCode: "r2_subscription_required",
    });
    expect(await env.CONTROL_DB.prepare(
      "SELECT status FROM provisioning_steps WHERE installation_id = ? AND step_code = 'd1'",
    ).bind(installationId).first()).toEqual({ status: "complete" });
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      provisioningFetcher(),
      201,
    )).resolves.toMatchObject({ status: "ready" });
    expect(await env.CONTROL_DB.prepare(
      "SELECT resource_type FROM installation_resources WHERE installation_id = ? AND resource_type = 'thumbnail_r2'",
    ).bind(installationId).first()).toEqual({ resource_type: "thumbnail_r2" });
  });

  it("resumes after a partial provider outage without recreating completed resources", async () => {
    const { installationId, ownerId } = await authorizedInstallation("kv");
    const fetcher = provisioningFetcher({ failVectorizeOnce: true });
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      200,
    )).resolves.toEqual({ status: "failed" });
    expect(await env.CONTROL_DB.prepare(
      "SELECT status FROM provisioning_steps WHERE installation_id = ? AND step_code = 'thumbnail_kv'",
    ).bind(installationId).first()).toEqual({ status: "complete" });
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      201,
    )).resolves.toMatchObject({ status: "ready" });
    const d1Creates = fetcher.mock.calls.filter(([input, init]) => {
      const request = new Request(input, init);
      return request.method === "POST" && new URL(request.url).pathname.endsWith("/d1/database");
    });
    expect(d1Creates).toHaveLength(1);
  });

  it("rejects a script-name fallback when Cloudflare omits the Worker version id", async () => {
    const { ownerId } = await authorizedInstallation("kv");
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      provisioningFetcher({ invalidWorkerVersion: true }),
      200,
    )).resolves.toEqual({ status: "failed" });
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      status: "failed",
      installedRelease: null,
      safeErrorCode: "cloudflare_unavailable",
    });
  });

  it("waits out new workers.dev propagation instead of pausing the owner's setup", async () => {
    const { installationId, ownerId } = await authorizedInstallation("kv");
    const fetcher = provisioningFetcher({ healthUnavailableCount: 2 });
    const waits: number[] = [];
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      200,
      (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    )).resolves.toMatchObject({ status: "ready" });
    expect(waits).toEqual([6000, 6000]);
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      status: "ready",
      safeErrorCode: null,
    });
    expect(await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM provisioning_steps WHERE installation_id = ? AND status = 'complete'",
    ).bind(installationId).first()).toEqual({ count: 12 });
  });

  it("still pauses when the runtime stays unreachable after every bounded retry", async () => {
    const { ownerId } = await authorizedInstallation("kv");
    const fetcher = provisioningFetcher({ healthUnavailableCount: 99 });
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      200,
      () => Promise.resolve(),
    )).resolves.toEqual({ status: "failed" });
    expect(fetcher.mock.calls.filter(([input]) =>
      new URL(new Request(input).url).pathname === "/health"
    )).toHaveLength(5);
    expect(fetcher.mock.calls.some(([input, init]) => {
      const request = new Request(input, init);
      return request.method === "DELETE" &&
        new URL(request.url).pathname.endsWith("/workers/scripts/later-gator");
    })).toBe(true);
    expect(await env.CONTROL_DB.prepare(
      "SELECT status, current_step, safe_error_code FROM installations WHERE owner_id = ?",
    ).bind(ownerId).first()).toEqual({
      status: "failed",
      current_step: "worker_upload",
      safe_error_code: "cloudflare_unavailable",
    });
  });

  it("uses the uploaded version receipt in the same-account development topology", async () => {
    const { installationId, ownerId } = await authorizedInstallation("kv");
    const fetcher = provisioningFetcher({ healthWorkerFetchBlocked: true });
    const developmentConfig: ControlConfig = {
      ...config,
      environment: "development",
      publicOrigin: "https://later-gator-control-plane-dev.owner-subdomain.workers.dev",
    };
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      developmentConfig,
      ownerId,
      fetcher,
      200,
      () => Promise.resolve(),
    )).resolves.toMatchObject({ status: "ready" });
    expect(fetcher.mock.calls.filter(([input]) =>
      new URL(new Request(input).url).pathname === "/health"
    )).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([input]) =>
      new URL(new Request(input).url).pathname.endsWith("/deployments")
    )).toHaveLength(0);
    expect(await env.CONTROL_DB.prepare(
      "SELECT status, current_version_id FROM installations WHERE id = ?",
    ).bind(installationId).first()).toEqual({
      status: "ready",
      current_version_id: INITIAL_VERSION,
    });
  });

  it("restores the uploaded version receipt when a failed health step resumes", async () => {
    const { installationId, ownerId } = await authorizedInstallation("kv");
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      provisioningFetcher({ healthUnavailableCount: 99 }),
      200,
      () => Promise.resolve(),
    )).resolves.toEqual({ status: "failed" });
    const resumedFetcher = provisioningFetcher({ healthUnavailableCount: 99 });
    const developmentConfig: ControlConfig = {
      ...config,
      environment: "development",
      publicOrigin: "https://later-gator-control-plane-dev.owner-subdomain.workers.dev",
    };
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      developmentConfig,
      ownerId,
      resumedFetcher,
      201,
      () => Promise.resolve(),
    )).resolves.toMatchObject({ status: "ready" });
    expect(resumedFetcher.mock.calls.filter(([input]) =>
      new URL(new Request(input).url).pathname === "/health"
    )).toHaveLength(0);
    expect(resumedFetcher.mock.calls.filter(([input]) =>
      new URL(new Request(input).url).pathname.endsWith("/deployments")
    )).toHaveLength(0);
    expect(await env.CONTROL_DB.prepare(
      "SELECT status, current_version_id FROM installations WHERE id = ?",
    ).bind(installationId).first()).toEqual({
      status: "ready",
      current_version_id: INITIAL_VERSION,
    });
  });

  it("recreates a personal Worker deleted after a failed provisioning attempt", async () => {
    const { installationId, ownerId } = await authorizedInstallation("kv");
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      provisioningFetcher({ healthUnavailableCount: 99 }),
      200,
      () => Promise.resolve(),
    )).resolves.toEqual({ status: "failed" });
    const resumedFetcher = provisioningFetcher({ workerMissing: true });
    const developmentConfig: ControlConfig = {
      ...config,
      environment: "development",
      publicOrigin: "https://later-gator-control-plane-dev.owner-subdomain.workers.dev",
    };
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      developmentConfig,
      ownerId,
      resumedFetcher,
      201,
      () => Promise.resolve(),
    )).resolves.toMatchObject({ status: "ready" });
    expect(resumedFetcher.mock.calls.filter(([input, init]) => {
      const request = new Request(input, init);
      return request.method === "PUT" && /\/workers\/scripts\/[^/]+$/u.test(
        new URL(request.url).pathname,
      );
    })).toHaveLength(1);
    expect(await env.CONTROL_DB.prepare(
      `SELECT step_code, status, attempt_count FROM provisioning_steps
        WHERE installation_id = ? AND step_code IN (
          'worker_upload', 'queue_consumers', 'workers_dev', 'health_check'
        ) ORDER BY step_code`,
    ).bind(installationId).all()).toMatchObject({
      results: [
        { step_code: "health_check", status: "complete", attempt_count: 2 },
        { step_code: "queue_consumers", status: "complete", attempt_count: 2 },
        { step_code: "worker_upload", status: "complete", attempt_count: 2 },
        { step_code: "workers_dev", status: "complete", attempt_count: 2 },
      ],
    });
  });

  it("does not bypass an exact Worker fetch block outside the same development namespace", async () => {
    const { ownerId } = await authorizedInstallation("kv");
    const fetcher = provisioningFetcher({ healthWorkerFetchBlocked: true });
    await expect(provisionOwnerInstallation(
      env.CONTROL_DB,
      env.RELEASE_ARTIFACTS,
      config,
      ownerId,
      fetcher,
      200,
      () => Promise.resolve(),
    )).resolves.toEqual({ status: "failed" });
    expect(fetcher.mock.calls.filter(([input]) =>
      new URL(new Request(input).url).pathname === "/health"
    )).toHaveLength(1);
    expect(await findOwnerInstallationSummary(env.CONTROL_DB, ownerId)).toMatchObject({
      status: "failed",
      safeErrorCode: "cloudflare_worker_fetch_blocked",
    });
  });
});
