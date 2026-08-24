import {
  CloudflareProvisioner,
  CloudflareProvisioningError,
  type ProvisionedResources,
} from "../adapters/cloudflare-provisioning";
import type { SystemHealth } from "@later-gator/contracts";
import {
  discoverCloudflareIdentity,
  type Fetcher as HttpFetcher,
} from "../adapters/cloudflare-identity";
import { refreshCloudflareInstallerToken } from "../adapters/cloudflare-installer";
import {
  claimProvisioningStep,
  completeResourceCleanup,
  completeProvisioningStep,
  failProvisioningStep,
  findCompletedProvisioningStepResourceId,
  findInstallationResource,
  findInstallerAuthorization,
  findProvisioningInstallation,
  findProvisioningStepStatus,
  markInstallationReady,
  recordProvisionedWorkerVersion,
  recordInstallationResource,
  reopenProvisioningAfterMissingWorker,
  storeInstallerAuthorization,
  type InstallationResource,
  type ProvisioningStepCode,
} from "../adapters/installation-repository";
import {
  completeControlMigration,
  startControlMigration,
} from "../adapters/release-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { decryptInstallerToken, encryptInstallerToken } from "../security/installer-token-vault";
import { loadRuntimeRelease, planRuntimeMigrations } from "./releases";

const RELEASE = "1.0.0";
const HEALTH_CHECK_ATTEMPTS = 5;
const HEALTH_CHECK_RETRY_DELAY_MS = 6_000;

/** Returns the account-owned workers.dev namespace shared by sibling Workers. */
function workersDevNamespace(origin: string): string | null {
  const labels = new URL(origin).hostname.toLowerCase().split(".");
  if (
    labels.length < 4 ||
    labels.at(-2) !== "workers" ||
    labels.at(-1) !== "dev"
  ) return null;
  return labels.slice(-3).join(".");
}

/** Limits the provider-metadata fallback to the same-account development topology. */
function canUseDevelopmentHealthFallback(
  config: ControlConfig,
  workerOrigin: string,
): boolean {
  if (config.environment !== "development") return false;
  const controlNamespace = workersDevNamespace(config.publicOrigin);
  return controlNamespace !== null && controlNamespace === workersDevNamespace(workerOrigin);
}

/** Waits without consuming CPU time; replaceable in tests to keep them fast. */
async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Retries a temporarily unreachable new workers.dev origin so first-provisioning
 * health checks survive address propagation delays without owner intervention.
 * Incompatible runtime responses are never retried.
 */
async function waitForFirstHealthyResponse(
  cloudflare: CloudflareProvisioner,
  workerOrigin: string,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<SystemHealth> {
  let lastUnavailable: CloudflareProvisioningError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(HEALTH_CHECK_RETRY_DELAY_MS);
    try {
      return await cloudflare.health(workerOrigin);
    } catch (error) {
      if (
        error instanceof CloudflareProvisioningError &&
        error.safeCode === "cloudflare_unavailable" &&
        attempt < attempts
      ) {
        lastUnavailable = error;
        continue;
      }
      throw error;
    }
  }
  throw lastUnavailable ?? new CloudflareProvisioningError("cloudflare_unavailable", 503);
}

/** Encodes exactly 32 random bytes as standard base64 for the personal runtime vault. */
function instanceMasterKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Returns the single reserved Later Gator resource set for one Cloudflare account. */
function resourceNames(): {
  d1: string;
  oauthKv: string;
  thumbnails: string;
  vectorize: string;
  backgroundQueue: string;
  thumbnailQueue: string;
  worker: string;
} {
  const prefix = "later-gator";
  return {
    d1: `${prefix}-db`,
    oauthKv: `${prefix}-oauth`,
    thumbnails: `${prefix}-thumbnails`,
    vectorize: `${prefix}-vectors`,
    backgroundQueue: `${prefix}-background`,
    thumbnailQueue: `${prefix}-thumbnail-jobs`,
    worker: prefix,
  };
}

/** Removes a partially uploaded runtime before a failed installation becomes retryable. */
async function removeFailedWorker(
  database: D1Database,
  cloudflare: CloudflareProvisioner,
  installationId: string,
  workerName: string,
  nowSeconds: number,
): Promise<void> {
  if (!await cloudflare.workerExists(workerName)) return;
  await cloudflare.deleteResource({ type: "worker", id: workerName, name: workerName });
  await completeResourceCleanup(database, installationId, "worker", nowSeconds);
  await reopenProvisioningAfterMissingWorker(database, installationId, nowSeconds);
}

/** Loads one required resource or fails before a Worker can receive partial bindings. */
async function requiredResource(
  database: D1Database,
  installationId: string,
  type: InstallationResource["type"],
): Promise<InstallationResource> {
  const resource = await findInstallationResource(database, installationId, type);
  if (resource === null) throw new Error(`provisioning_resource_missing:${type}`);
  return resource;
}

/** Reconstructs the complete binding set from privacy-safe resource records. */
async function provisionedResources(
  database: D1Database,
  installationId: string,
  storageMode: "kv" | "r2",
  names: ReturnType<typeof resourceNames>,
  workerOrigin: string,
): Promise<ProvisionedResources> {
  const [d1, oauthKv, thumbnails, vectorize, background, thumbnail] = await Promise.all([
    requiredResource(database, installationId, "d1"),
    requiredResource(database, installationId, "oauth_kv"),
    requiredResource(database, installationId, storageMode === "kv" ? "thumbnail_kv" : "thumbnail_r2"),
    requiredResource(database, installationId, "vectorize"),
    requiredResource(database, installationId, "background_queue"),
    requiredResource(database, installationId, "thumbnail_queue"),
  ]);
  return {
    d1DatabaseId: d1.id,
    oauthKvNamespaceId: oauthKv.id,
    thumbnailStorageId: thumbnails.id,
    vectorizeIndexName: vectorize.id,
    backgroundQueueId: background.id,
    backgroundQueueName: background.name,
    thumbnailQueueId: thumbnail.id,
    thumbnailQueueName: thumbnail.name,
    workerName: names.worker,
    workerOrigin,
  };
}

/** Returns a current access token, rotating and re-encrypting refresh credentials when needed. */
export async function currentInstallerAccessToken(
  database: D1Database,
  config: ControlConfig,
  ownerId: string,
  accountId: string,
  fetcher: HttpFetcher,
  nowSeconds: number,
): Promise<string> {
  const authorization = await findInstallerAuthorization(database, ownerId);
  if (authorization?.accountId !== accountId) {
    throw new ControlPlaneError("installer_callback_rejected", 401);
  }
  let token = await decryptInstallerToken(
    config.installerTokenEncryptionKey,
    ownerId,
    accountId,
    authorization,
  );
  if (token.expiresAt <= nowSeconds + 120) {
    const refreshed = await refreshCloudflareInstallerToken(
      await discoverCloudflareIdentity(config, fetcher),
      config,
      token.refreshToken,
      token.grantedScopes,
      fetcher,
    );
    const encrypted = await encryptInstallerToken(
      config.installerTokenEncryptionKey,
      ownerId,
      accountId,
      refreshed,
      nowSeconds,
    );
    await storeInstallerAuthorization(database, {
      ownerId,
      accountId,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      grantedScopesJson: JSON.stringify(refreshed.grantedScopes),
      expiresAt: encrypted.expiresAt,
      updatedAt: nowSeconds,
    });
    token = { ...refreshed, expiresAt: encrypted.expiresAt };
  }
  return token.accessToken;
}

export interface ProvisioningOutcome {
  status: "ready" | "in_progress" | "waiting_for_r2" | "failed";
  workerOrigin?: string;
}

/** Advances every resumable installation step until ready, paused, or concurrently owned. */
export async function provisionOwnerInstallation(
  database: D1Database,
  artifacts: Fetcher,
  config: ControlConfig,
  ownerId: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<ProvisioningOutcome> {
  const installation = await findProvisioningInstallation(database, ownerId);
  if (installation === null) throw new ControlPlaneError("bad_request", 400);
  if (installation.status === "ready") {
    const metadata = await database.prepare(
      "SELECT worker_origin FROM installation_runtime_metadata WHERE installation_id = ?",
    ).bind(installation.id).first<{ worker_origin: string }>();
    return metadata === null
      ? { status: "failed" }
      : { status: "ready", workerOrigin: metadata.worker_origin };
  }
  const accessToken = await currentInstallerAccessToken(
    database,
    config,
    ownerId,
    installation.accountId,
    fetcher,
    nowSeconds,
  );
  const cloudflare = new CloudflareProvisioner(installation.accountId, accessToken, fetcher);
  const artifact = await loadRuntimeRelease(artifacts, RELEASE);
  const names = resourceNames();
  const steps: ProvisioningStepCode[] = [
    "d1",
    "oauth_kv",
    installation.storageMode === "kv" ? "thumbnail_kv" : "thumbnail_r2",
    "vectorize",
    "background_queue",
    "thumbnail_queue",
    "runtime_secret",
    "worker_upload",
    "schema_initialize",
    "queue_consumers",
    "workers_dev",
    "health_check",
  ];
  let workerOrigin = "";
  let workerVersionId = await findCompletedProvisioningStepResourceId(
    database,
    installation.id,
    "worker_upload",
  ) ?? "";
  if (workerVersionId !== "" && !await cloudflare.workerExists(names.worker)) {
    await reopenProvisioningAfterMissingWorker(database, installation.id, nowSeconds);
    workerVersionId = "";
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) throw new Error("provisioning_step_invalid");
    const claimed = await claimProvisioningStep(database, installation.id, step, nowSeconds);
    if (!claimed) {
      const status = await findProvisioningStepStatus(database, installation.id, step);
      if (status === "complete") continue;
      return { status: "in_progress" };
    }
    const next = steps[index + 1] ?? null;
    try {
      let stepResourceId: string | null = null;
      if (step === "d1") {
        stepResourceId = await cloudflare.ensureD1(names.d1);
        await recordInstallationResource(database, installation.id, {
          type: "d1", name: names.d1, id: stepResourceId,
        }, nowSeconds);
      } else if (step === "oauth_kv") {
        stepResourceId = await cloudflare.ensureKv(names.oauthKv);
        await recordInstallationResource(database, installation.id, {
          type: "oauth_kv", name: names.oauthKv, id: stepResourceId,
        }, nowSeconds);
      } else if (step === "thumbnail_kv") {
        stepResourceId = await cloudflare.ensureKv(names.thumbnails);
        await recordInstallationResource(database, installation.id, {
          type: "thumbnail_kv", name: names.thumbnails, id: stepResourceId,
        }, nowSeconds);
      } else if (step === "thumbnail_r2") {
        stepResourceId = await cloudflare.ensureR2(names.thumbnails);
        await recordInstallationResource(database, installation.id, {
          type: "thumbnail_r2", name: names.thumbnails, id: stepResourceId,
        }, nowSeconds);
      } else if (step === "vectorize") {
        stepResourceId = await cloudflare.ensureVectorize(names.vectorize);
        await recordInstallationResource(database, installation.id, {
          type: "vectorize", name: names.vectorize, id: stepResourceId,
        }, nowSeconds);
      } else if (step === "background_queue" || step === "thumbnail_queue") {
        const name = step === "background_queue" ? names.backgroundQueue : names.thumbnailQueue;
        const queue = await cloudflare.ensureQueue(name);
        stepResourceId = queue.id;
        await recordInstallationResource(database, installation.id, {
          type: step, name: queue.name, id: queue.id,
        }, nowSeconds);
      } else if (step === "worker_upload") {
        const subdomain = await cloudflare.accountSubdomain();
        workerOrigin = `https://${names.worker}.${subdomain}.workers.dev`;
        const resources = await provisionedResources(
          database,
          installation.id,
          installation.storageMode,
          names,
          workerOrigin,
        );
        const uploaded = await cloudflare.uploadInitialWorker(
          artifact,
          artifacts,
          resources,
          installation.id,
          installation.storageMode,
          config.publicOrigin,
          instanceMasterKey(),
        );
        workerVersionId = uploaded.versionId;
        stepResourceId = uploaded.versionId;
        await recordInstallationResource(database, installation.id, {
          type: "worker", name: names.worker, id: names.worker,
        }, nowSeconds);
      } else if (step === "schema_initialize") {
        const d1 = await requiredResource(database, installation.id, "d1");
        const bookmark = await cloudflare.timeTravelBookmark(d1.id);
        for (const migration of planRuntimeMigrations(artifact, 0)) {
          const action = await startControlMigration(database, {
            installationId: installation.id,
            migrationId: migration.id,
            checksum: migration.sha256,
            fromSchemaVersion: migration.fromSchemaVersion,
            toSchemaVersion: migration.toSchemaVersion,
            phase: migration.phase,
            bookmark,
            nowSeconds,
          });
          if (action === "run") {
            await cloudflare.applySchema(d1.id, migration.statements);
            await completeControlMigration(database, installation.id, migration.id, nowSeconds);
          }
        }
      } else if (step === "queue_consumers") {
        const [background, thumbnail] = await Promise.all([
          requiredResource(database, installation.id, "background_queue"),
          requiredResource(database, installation.id, "thumbnail_queue"),
        ]);
        await cloudflare.ensureQueueConsumer(background.id, names.worker, 1);
        await cloudflare.ensureQueueConsumer(thumbnail.id, names.worker, 3);
      } else if (step === "workers_dev") {
        await cloudflare.enableWorkersDev(names.worker);
      } else if (step === "health_check") {
        if (workerOrigin === "") {
          const subdomain = await cloudflare.accountSubdomain();
          workerOrigin = `https://${names.worker}.${subdomain}.workers.dev`;
        }
        const developmentWorkerFetchBlocked = canUseDevelopmentHealthFallback(
          config,
          workerOrigin,
        );
        if (!developmentWorkerFetchBlocked || workerVersionId === "") {
          try {
            const health = await waitForFirstHealthyResponse(
              cloudflare,
              workerOrigin,
              HEALTH_CHECK_ATTEMPTS,
              sleep,
            );
            if (
              health.status !== "ready" ||
              health.runtimeRelease !== artifact.release ||
              health.schemaVersion < artifact.minimumSchemaVersion ||
              health.schemaVersion > artifact.maximumSchemaVersion
            ) {
              throw new Error("runtime_health_incompatible");
            }
          } catch (error) {
            if (
              !(error instanceof CloudflareProvisioningError) ||
              error.safeCode !== "cloudflare_worker_fetch_blocked" ||
              !developmentWorkerFetchBlocked
            ) throw error;
          }
        }
        if (workerVersionId === "") workerVersionId = await cloudflare.activeVersion(names.worker);
        await recordProvisionedWorkerVersion(
          database,
          installation.id,
          workerVersionId,
          nowSeconds,
        );
        await markInstallationReady(
          database,
          installation.id,
          workerOrigin,
          artifact.release,
          workerVersionId,
          artifact.artifactDigest,
          artifact.maximumSchemaVersion,
          nowSeconds,
        );
      }
      await completeProvisioningStep(
        database,
        installation.id,
        step,
        next,
        stepResourceId,
        nowSeconds,
      );
    } catch (error) {
      const r2Pause = error instanceof CloudflareProvisioningError &&
        error.safeCode === "r2_subscription_required";
      const safeError = error instanceof CloudflareProvisioningError
        ? error.safeCode
        : "provisioning_step_failed";
      const workerUploadIndex = steps.indexOf("worker_upload");
      if (!r2Pause && index >= workerUploadIndex) {
        try {
          await removeFailedWorker(
            database,
            cloudflare,
            installation.id,
            names.worker,
            nowSeconds,
          );
        } catch {
          await failProvisioningStep(
            database,
            installation.id,
            step,
            "worker_cleanup_failed",
            false,
            nowSeconds,
          );
          return { status: "failed" };
        }
      }
      await failProvisioningStep(
        database,
        installation.id,
        step,
        safeError,
        r2Pause,
        nowSeconds,
      );
      return { status: r2Pause ? "waiting_for_r2" : "failed" };
    }
  }
  return { status: "ready", workerOrigin };
}
