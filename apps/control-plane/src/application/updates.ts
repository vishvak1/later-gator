import { CloudflareProvisioner, type ProvisionedResources } from "../adapters/cloudflare-provisioning";
import { findInstallationResource } from "../adapters/installation-repository";
import {
  completeControlMigration,
  completeReleasePromotion,
  findUpdatableInstallation,
  installationInActiveCohort,
  recordRolloutOutcome,
  setReleaseUpdateState,
  startControlMigration,
  startReleaseUpdate,
} from "../adapters/release-repository";
import type { ControlConfig } from "../domain/config";
import { currentInstallerAccessToken } from "./provisioning";
import { automaticRuntimeMigrations, loadRuntimeRelease } from "./releases";

export interface RuntimeUpdateOutcome {
  status: "already_current" | "outside_cohort" | "updated" | "failed" | "rolled_back";
  release: string;
}

/** Reconstructs the current binding inventory without reading the personal runtime. */
async function updateResources(
  database: D1Database,
  installationId: string,
  storageMode: "kv" | "r2",
  workerOrigin: string,
): Promise<ProvisionedResources> {
  /** Loads one required binding resource from the control-plane inventory. */
  const required = async (type: Parameters<typeof findInstallationResource>[2]) => {
    const resource = await findInstallationResource(database, installationId, type);
    if (resource === null) throw new Error(`update_resource_missing:${type}`);
    return resource;
  };
  const [d1, oauthKv, thumbnailStorage, vectorize, background, thumbnail, worker] =
    await Promise.all([
      required("d1"),
      required("oauth_kv"),
      required(storageMode === "kv" ? "thumbnail_kv" : "thumbnail_r2"),
      required("vectorize"),
      required("background_queue"),
      required("thumbnail_queue"),
      required("worker"),
    ]);
  return {
    d1DatabaseId: d1.id,
    oauthKvNamespaceId: oauthKv.id,
    thumbnailStorageId: thumbnailStorage.id,
    vectorizeIndexName: vectorize.id,
    backgroundQueueId: background.id,
    backgroundQueueName: background.name,
    thumbnailQueueId: thumbnail.id,
    thumbnailQueueName: thumbnail.name,
    workerName: worker.name,
    workerOrigin,
  };
}

/** Returns the latest successfully promoted schema version tracked by the control plane. */
async function installedSchemaVersion(
  database: D1Database,
  installationId: string,
): Promise<number> {
  const row = await database.prepare(
    `SELECT MAX(schema_version) AS schema_version FROM runtime_release_history
      WHERE installation_id = ? AND state = 'promoted'`,
  ).bind(installationId).first<{ schema_version: number | null }>();
  return row?.schema_version ?? 0;
}

/** Applies one cohort-authorized immutable release with staged health and compatible rollback. */
export async function updateOwnerRuntime(
  database: D1Database,
  artifacts: Fetcher,
  config: ControlConfig,
  ownerId: string,
  targetRelease: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<RuntimeUpdateOutcome> {
  const installation = await findUpdatableInstallation(database, ownerId);
  if (installation === null) return { status: "failed", release: targetRelease };
  if (installation.installedRelease === targetRelease) {
    return { status: "already_current", release: targetRelease };
  }
  if (!await installationInActiveCohort(
    database,
    targetRelease,
    installation.rolloutCohort,
  )) return { status: "outside_cohort", release: targetRelease };

  const artifact = await loadRuntimeRelease(artifacts, targetRelease);
  const schemaVersion = await installedSchemaVersion(database, installation.id);
  let applicable: ReturnType<typeof automaticRuntimeMigrations>;
  try {
    applicable = automaticRuntimeMigrations(artifact, schemaVersion);
  } catch {
    return { status: "failed", release: targetRelease };
  }
  await startReleaseUpdate(database, {
    installationId: installation.id,
    release: targetRelease,
    artifactDigest: artifact.artifactDigest,
    schemaVersion: artifact.maximumSchemaVersion,
    previousVersionId: installation.currentVersionId,
    nowSeconds,
  });
  let failed = true;
  try {
    const accessToken = await currentInstallerAccessToken(
      database,
      config,
      ownerId,
      installation.accountId,
      fetcher,
      nowSeconds,
    );
    const cloudflare = new CloudflareProvisioner(installation.accountId, accessToken, fetcher);
    const resources = await updateResources(
      database,
      installation.id,
      installation.storageMode,
      installation.workerOrigin,
    );
    let bookmark: string | undefined;
    if (applicable.length > 0) {
      bookmark = await cloudflare.timeTravelBookmark(resources.d1DatabaseId);
      await setReleaseUpdateState(database, installation.id, targetRelease, "migrating", {
        bookmark,
        nowSeconds,
      });
      for (const migration of applicable) {
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
          await cloudflare.applySchema(resources.d1DatabaseId, migration.statements);
          await completeControlMigration(database, installation.id, migration.id, nowSeconds);
        }
      }
    }
    const uploaded = await cloudflare.uploadWorkerVersion(
      artifact,
      artifacts,
      resources,
      installation.id,
      installation.storageMode,
      config.publicOrigin,
    );
    await setReleaseUpdateState(database, installation.id, targetRelease, "uploaded", {
      versionId: uploaded.versionId,
      ...(bookmark === undefined ? {} : { bookmark }),
      nowSeconds,
    });
    const stagedDeployment = await cloudflare.stageVersion(
      resources.workerName,
      installation.currentVersionId,
      uploaded.versionId,
    );
    const stagedHealth = await cloudflare.health(installation.workerOrigin, {
      workerName: resources.workerName,
      versionId: uploaded.versionId,
    });
    if (
      stagedHealth.status !== "ready" ||
      stagedHealth.runtimeRelease !== targetRelease ||
      stagedHealth.schemaVersion < artifact.minimumSchemaVersion ||
      stagedHealth.schemaVersion > artifact.maximumSchemaVersion
    ) throw new Error("candidate_health_failed");
    await setReleaseUpdateState(database, installation.id, targetRelease, "healthy", {
      deploymentId: stagedDeployment,
      nowSeconds,
    });
    const deploymentId = await cloudflare.promoteVersion(resources.workerName, uploaded.versionId);
    const promotedHealth = await cloudflare.health(installation.workerOrigin);
    if (promotedHealth.status !== "ready" || promotedHealth.runtimeRelease !== targetRelease) {
      const rollbackCompatible = applicable.every((migration) => migration.phase === "expand");
      if (rollbackCompatible) {
        await cloudflare.promoteVersion(resources.workerName, installation.currentVersionId);
        await setReleaseUpdateState(database, installation.id, targetRelease, "rolled_back", {
          versionId: uploaded.versionId,
          deploymentId,
          safeErrorCode: "post_promotion_health_failed",
          nowSeconds,
        });
        await recordRolloutOutcome(database, targetRelease, true, nowSeconds);
        failed = false;
        return { status: "rolled_back", release: targetRelease };
      }
      throw new Error("post_promotion_health_failed");
    }
    await completeReleasePromotion(database, installation, targetRelease, uploaded.versionId, nowSeconds);
    await setReleaseUpdateState(database, installation.id, targetRelease, "promoted", {
      versionId: uploaded.versionId,
      deploymentId,
      nowSeconds,
    });
    failed = false;
    await recordRolloutOutcome(database, targetRelease, false, nowSeconds);
    return { status: "updated", release: targetRelease };
  } catch {
    await setReleaseUpdateState(database, installation.id, targetRelease, "failed", {
      safeErrorCode: "runtime_update_failed",
      nowSeconds,
    });
    return { status: "failed", release: targetRelease };
  } finally {
    if (failed) await recordRolloutOutcome(database, targetRelease, true, nowSeconds);
  }
}
