import { CloudflareProvisioner } from "../adapters/cloudflare-provisioning";
import {
  findOwnerRuntimeInventory,
  reopenProvisioningAfterMissingWorker,
  revokeInstallerAuthorization,
  setRuntimeWorkerAvailability,
} from "../adapters/installation-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError, InstallerAuthorizationRevokedError } from "../domain/errors";
import { currentInstallerAccessToken, provisionOwnerInstallation } from "./provisioning";

export type RuntimeReconciliation = "available" | "missing" | "not_installed" | "unchecked";

/** Checks Cloudflare's Worker inventory without requesting any personal runtime data. */
export async function reconcileOwnerRuntime(
  database: D1Database,
  config: ControlConfig,
  ownerId: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<RuntimeReconciliation> {
  const inventory = await findOwnerRuntimeInventory(database, ownerId);
  if (inventory === null) return "not_installed";
  try {
    const token = await currentInstallerAccessToken(
      database,
      config,
      ownerId,
      inventory.accountId,
      fetcher,
      nowSeconds,
    );
    const cloudflare = new CloudflareProvisioner(inventory.accountId, token, fetcher);
    const available = await cloudflare.workerExists(inventory.workerName);
    await setRuntimeWorkerAvailability(
      database,
      inventory.installationId,
      available,
      nowSeconds,
    );
    return available ? "available" : "missing";
  } catch (error) {
    if (error instanceof InstallerAuthorizationRevokedError) {
      await revokeInstallerAuthorization(database, ownerId, nowSeconds);
    }
    return "unchecked";
  }
}

/** Recreates only a definitively missing Worker while retaining the owner's personal stores. */
export async function repairMissingOwnerRuntime(
  database: D1Database,
  artifacts: Fetcher,
  config: ControlConfig,
  ownerId: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (await reconcileOwnerRuntime(database, config, ownerId, fetcher, nowSeconds) !== "missing") {
    throw new ControlPlaneError("bad_request", 409);
  }
  const inventory = await findOwnerRuntimeInventory(database, ownerId);
  if (inventory === null) throw new ControlPlaneError("bad_request", 409);
  await reopenProvisioningAfterMissingWorker(database, inventory.installationId, nowSeconds);
  await provisionOwnerInstallation(
    database,
    artifacts,
    config,
    ownerId,
    fetcher,
    nowSeconds,
  );
}
