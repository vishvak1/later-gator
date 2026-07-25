import { OperationalStateStore } from "../adapters/operational-state-store";
import type {
  RaindropPage,
  RaindropUser,
} from "../adapters/raindrop-client";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import {
  DispatchMessageSchema,
  type DispatchMessage,
  type DispatchState,
} from "../domain/schemas";

const UNSORTED_COLLECTION_ID = -1;
const LEASE_TTL_MILLISECONDS = 30 * 60 * 1_000;

export interface DispatchResult {
  outcome:
    | "enqueued"
    | "empty"
    | "guarded"
    | "account_mismatch"
    | "all_leased";
  discovered: number;
  enqueued: number;
}

export interface DispatchRaindropGateway {
  getCurrentUser(): Promise<RaindropUser>;
  listRaindrops(
    collectionId: number,
    options?: {
      page?: number;
      perPage?: number;
      search?: string;
      sort?: string;
      nested?: boolean;
    },
  ): Promise<RaindropPage>;
}

export interface DispatchQueueGateway {
  sendBatch(
    messages: MessageSendRequest<DispatchMessage>[],
  ): Promise<unknown>;
}

export async function dispatchUnsorted(
  namespace: KVNamespace,
  queue: DispatchQueueGateway,
  raindrop: DispatchRaindropGateway,
  dispatchLimit: number,
  now = new Date(),
  source: "queue" | "backfill" = "queue",
): Promise<DispatchResult> {
  const onboarding = await new OnboardingStateStore(namespace).get();
  if (onboarding.status !== "complete" || onboarding.accountUserId === null) {
    return { outcome: "guarded", discovered: 0, enqueued: 0 };
  }

  const operational = new OperationalStateStore(namespace);
  const pipeline = await operational.getPipeline();
  if (
    pipeline.paused ||
    (source === "queue" && pipeline.mode === "backfill") ||
    (source === "backfill" && pipeline.mode !== "backfill") ||
    (pipeline.deferredUntil !== null && new Date(pipeline.deferredUntil) > now)
  ) {
    return { outcome: "guarded", discovered: 0, enqueued: 0 };
  }

  const user = await raindrop.getCurrentUser();
  if (user.id !== onboarding.accountUserId) {
    return { outcome: "account_mismatch", discovered: 0, enqueued: 0 };
  }

  const page = await raindrop.listRaindrops(UNSORTED_COLLECTION_ID, {
    page: 0,
    perPage: 50,
    sort: "-created",
  });
  if (page.items.length === 0) {
    return { outcome: "empty", discovered: 0, enqueued: 0 };
  }

  const dispatch = await operational.getDispatch();
  const liveLeases = pruneLeases(dispatch, now);
  const selected = page.items
    .filter((bookmark) => liveLeases[bookmark.id.toString()] === undefined)
    .slice(0, dispatchLimit);
  if (selected.length === 0) {
    return { outcome: "all_leased", discovered: page.items.length, enqueued: 0 };
  }

  const revision = crypto.randomUUID();
  const enqueuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MILLISECONDS).toISOString();
  const messages: DispatchMessage[] = selected.map((bookmark) =>
    DispatchMessageSchema.parse({
      bookmarkId: bookmark.id,
      raindropUserId: onboarding.accountUserId,
      dispatchRevision: revision,
      enqueuedAt,
      source,
    }),
  );
  const next: DispatchState = {
    ...dispatch,
    leases: {
      ...liveLeases,
      ...Object.fromEntries(
        selected.map((bookmark) => [
          bookmark.id.toString(),
          { dispatchRevision: revision, expiresAt },
        ]),
      ),
    },
    lastDiscoveryAt: enqueuedAt,
    lastDiscovered: page.items.length,
    lastEnqueued: selected.length,
    revision: dispatch.revision + 1,
  };
  await operational.putDispatch(next);
  await queue.sendBatch(
    messages.map((body) => ({ body, contentType: "json" as const })),
  );
  return {
    outcome: "enqueued",
    discovered: page.items.length,
    enqueued: selected.length,
  };
}

export async function clearDispatchLease(
  namespace: KVNamespace,
  bookmarkId: number,
): Promise<void> {
  const store = new OperationalStateStore(namespace);
  const current = await store.getDispatch();
  const key = bookmarkId.toString();
  if (current.leases[key] === undefined) return;
  const leases = Object.fromEntries(
    Object.entries(current.leases).filter(([leaseKey]) => leaseKey !== key),
  );
  await store.putDispatch({
    ...current,
    leases,
    revision: current.revision + 1,
  });
}

function pruneLeases(
  state: DispatchState,
  now: Date,
): DispatchState["leases"] {
  return Object.fromEntries(
    Object.entries(state.leases).filter(
      ([, lease]) => new Date(lease.expiresAt) > now,
    ),
  );
}
