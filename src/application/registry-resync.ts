import type { AdminStateStore } from "../adapters/admin-state-store";
import type { RaindropFilters } from "../adapters/raindrop-client";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { OperationalStateStore } from "../adapters/operational-state-store";
import { SEED_TAGS } from "../domain/seed";

export interface RegistryResyncGateway {
  getFilters(collectionId: number): Promise<RaindropFilters>;
}

export async function resyncRegistryIfDue(
  namespace: KVNamespace,
  raindrop: RegistryResyncGateway,
  now: Date,
  adminStore: AdminStateStore,
  force = false,
): Promise<"resynced" | "not_due" | "guarded"> {
  const onboarding = await new OnboardingStateStore(namespace).get();
  const operational = new OperationalStateStore(namespace);
  const pipeline = await operational.getPipeline();
  if (onboarding.status !== "complete" || pipeline.mode === "backfill") return "guarded";

  const maintenance = await adminStore.getMaintenance();
  const today = now.toISOString().slice(0, 10);
  if (
    !force &&
    maintenance.lastRegistryResyncAt?.slice(0, 10) === today
  ) {
    return "not_due";
  }

  const counts = new Map<string, number>(SEED_TAGS.map((tag) => [tag, 0]));
  for (const folderId of Object.values(onboarding.folderIds)) {
    const filters = await raindrop.getFilters(folderId);
    for (const tag of filters.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + tag.count);
  }
  const previous = await operational.getRegistry();
  if (previous === null) return "guarded";
  const at = now.toISOString();
  await operational.putRegistry({
    ...previous,
    tags: Object.fromEntries(
      [...counts.entries()].map(([name, count]) => {
        const old = previous.tags[name];
        return [
          name,
          {
            count,
            firstUsedAt: old?.firstUsedAt ?? at,
            lastUsedAt: count > 0 ? at : (old?.lastUsedAt ?? at),
          },
        ];
      }),
    ),
    updatedAt: at,
    source: "resync",
  });
  await adminStore.putMaintenance({
    ...maintenance,
    lastRegistryResyncAt: at,
    revision: maintenance.revision + 1,
  });
  await adminStore.recordActivity({ at, event: "registry_resync", outcome: "completed" });
  return "resynced";
}
