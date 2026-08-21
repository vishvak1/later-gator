import { CloudflareProvisioner } from "../adapters/cloudflare-provisioning";
import {
  beginInstallationCleanup,
  completeInstallationCleanup,
  completeResourceCleanup,
  findCleanupInstallation,
  listCleanupResources,
  type InstallationResource,
} from "../adapters/installation-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { currentInstallerAccessToken } from "./provisioning";

const cleanupOrder: InstallationResource["type"][] = [
  "worker",
  "background_queue",
  "thumbnail_queue",
  "vectorize",
  "thumbnail_r2",
  "thumbnail_kv",
  "oauth_kv",
  "d1",
];

/** Deletes only recorded Later-Gator-created resources after explicit owner confirmation. */
export async function cleanupOwnerInstallation(
  database: D1Database,
  config: ControlConfig,
  ownerId: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const installation = await findCleanupInstallation(database, ownerId);
  if (installation === null || installation.status === "ready") {
    throw new ControlPlaneError("bad_request", 400);
  }
  const token = await currentInstallerAccessToken(
    database,
    config,
    ownerId,
    installation.accountId,
    fetcher,
    nowSeconds,
  );
  await beginInstallationCleanup(database, installation.id, nowSeconds);
  const cloudflare = new CloudflareProvisioner(installation.accountId, token, fetcher);
  const pending = await listCleanupResources(database, installation.id);
  const byType = new Map(pending.map((resource) => [resource.type, resource]));
  for (const type of cleanupOrder) {
    const resource = byType.get(type);
    if (resource === undefined) continue;
    await cloudflare.deleteResource(resource);
    await completeResourceCleanup(database, installation.id, type, nowSeconds);
  }
  await completeInstallationCleanup(database, ownerId, installation.id);
}
