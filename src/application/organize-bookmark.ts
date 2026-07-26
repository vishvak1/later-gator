import type { Organizer } from "../adapters/organizer";
import { OrganizerError } from "../adapters/organizer";
import { OperationalStateStore } from "../adapters/operational-state-store";
import type { RaindropItem } from "../adapters/raindrop-client";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import {
  appendReviewReason,
  ensurePreservationBlock,
  normalizeTags,
  recoverOriginalExcerpt,
  routeFolder,
} from "../domain/organization-rules";
import type {
  OrganizationResult,
  ProviderConfigState,
  RegistryState,
} from "../domain/schemas";
import { clearDispatchLease } from "./dispatch";
import {
  SafeBookmarkContentResolver,
  type BookmarkContentResolver,
} from "../adapters/content-resolver";
import { RaindropHttpError } from "../adapters/raindrop-client";

const UNSORTED_COLLECTION_ID = -1;
const ESTIMATED_OUTPUT_NEURONS = 700;

export type OrganizeOutcome =
  | { outcome: "processed" | "reviewed" | "duplicate" }
  | { outcome: "item_retry"; reason: string }
  | { outcome: "transient"; reason: string; retryAt?: string }
  | { outcome: "deferred_budget"; retryAt: string }
  | { outcome: "systemic"; reason: string };

export interface OrganizeRaindropGateway {
  getRaindrop(id: number): Promise<RaindropItem>;
  updateRaindrop(
    id: number,
    update: {
      collectionId: number;
      tags: string[];
      excerpt: string;
      note: string;
      link?: string;
      title?: string;
    },
  ): Promise<RaindropItem>;
}

export async function organizeBookmark(
  namespace: KVNamespace,
  raindrop: OrganizeRaindropGateway,
  organizer: Organizer,
  provider: ProviderConfigState,
  bookmarkId: number,
  maxAttempts: number,
  workersAiDailySoftLimit: number,
  now = new Date(),
  resolver: BookmarkContentResolver = new SafeBookmarkContentResolver(),
): Promise<OrganizeOutcome> {
  const onboarding = await new OnboardingStateStore(namespace).get();
  if (
    onboarding.status !== "complete" ||
    onboarding.accountUserId === null ||
    onboarding.folderIds["Need for Review"] === undefined
  ) {
    return pauseSystemically(namespace, bookmarkId, "onboarding_incomplete");
  }

  const pipelineStore = new OperationalStateStore(namespace);
  const pipeline = await pipelineStore.getPipeline();
  if (pipeline.paused) return { outcome: "systemic", reason: "pipeline_paused" };

  let bookmark: RaindropItem;
  try {
    bookmark = await raindrop.getRaindrop(bookmarkId);
  } catch (error) {
    return raindropTransient(namespace, "raindrop_fetch_failed", error);
  }
  if (bookmark.collectionId !== UNSORTED_COLLECTION_ID) {
    await clearDispatchLease(namespace, bookmarkId);
    return { outcome: "duplicate" };
  }
  const bookmarkWithRecoveredExcerpt: RaindropItem =
    bookmark.excerpt.length === 0
      ? {
          ...bookmark,
          excerpt: recoverOriginalExcerpt(bookmark.note) ?? "",
        }
      : bookmark;
  const resolved = await resolver.resolve(bookmarkWithRecoveredExcerpt);
  const organizationInput: RaindropItem = {
    ...bookmark,
    title: resolved.title,
    excerpt: resolved.excerpt,
    link: resolved.link,
  };

  const registry = await pipelineStore.getRegistry();
  if (registry === null) return pauseSystemically(namespace, bookmarkId, "registry_missing");

  let result: OrganizationResult;
  try {
    result = await organizeWithSchemaRetry(
      namespace,
      organizer,
      provider,
      organizationInput,
      registry,
      workersAiDailySoftLimit,
      now,
    );
  } catch (error) {
    if (error instanceof BudgetDeferredError) {
      await deferForBudget(namespace, error.retryAt);
      await clearDispatchLease(namespace, bookmarkId);
      return { outcome: "deferred_budget", retryAt: error.retryAt };
    }
    if (error instanceof OrganizerError && error.kind === "systemic") {
      return pauseSystemically(namespace, bookmarkId, error.code);
    }
    if (error instanceof OrganizerError && error.kind === "transient") {
      if (error.retryAt !== null) {
        await deferForProvider(namespace, error.retryAt);
        return { outcome: "transient", reason: error.code, retryAt: error.retryAt };
      }
      return { outcome: "transient", reason: error.code };
    }
    return recordItemFailure(
      namespace,
      raindrop,
      onboarding.folderIds["Need for Review"],
      bookmark,
      registry,
      maxAttempts,
      "invalid_model_response",
    );
  }

  const normalized = normalizeTags(result.tags, Object.keys(registry.tags));
  if (normalized.accepted.length === 0) {
    return recordItemFailure(
      namespace,
      raindrop,
      onboarding.folderIds["Need for Review"],
      bookmark,
      registry,
      maxAttempts,
      "no_valid_tags",
    );
  }

  const folderName =
    result.confidence === "low"
      ? "Need for Review"
      : routeFolder(organizationInput.link, result.folder);
  const folderId = onboarding.folderIds[folderName];
  if (folderId === undefined) {
    return pauseSystemically(namespace, bookmarkId, "folder_missing");
  }

  let note = ensurePreservationBlock(bookmark.note, bookmark.link, bookmark.excerpt);
  if (result.confidence === "low") {
    const reviewReason = result.notes?.trim();
    note = appendReviewReason(
      note,
      reviewReason === undefined || reviewReason.length === 0
        ? "Low model confidence"
        : reviewReason,
    );
  }
  if (note.length > 10_000) {
    return recordItemFailure(
      namespace,
      raindrop,
      onboarding.folderIds["Need for Review"],
      bookmark,
      registry,
      maxAttempts,
      "note_limit",
    );
  }

  try {
    await raindrop.updateRaindrop(bookmark.id, {
      collectionId: folderId,
      tags: normalized.accepted,
      excerpt: result.description,
      note,
      ...(resolved.substituted ? { link: resolved.link, title: resolved.title } : {}),
    });
  } catch (error) {
    return raindropTransient(namespace, "raindrop_update_failed", error);
  }

  await mergeRegistryAfterSuccess(
    pipelineStore,
    registry,
    bookmark.id,
    normalized.accepted,
    now.toISOString(),
  );
  await clearDispatchLease(namespace, bookmark.id);
  return { outcome: result.confidence === "low" ? "reviewed" : "processed" };
}

async function organizeWithSchemaRetry(
  namespace: KVNamespace,
  organizer: Organizer,
  provider: ProviderConfigState,
  bookmark: RaindropItem,
  registry: RegistryState,
  workersAiDailySoftLimit: number,
  now: Date,
): Promise<OrganizationResult> {
  const input = {
    title: bookmark.title,
    excerpt: bookmark.excerpt,
    link: bookmark.link,
    registry: Object.entries(registry.tags)
      .sort(
        ([leftName, left], [rightName, right]) =>
          right.count - left.count || leftName.localeCompare(rightName),
      )
      .map(([name, entry]) => ({ name, count: entry.count })),
    personalInstructions: provider.personalInstructions,
    fullPromptOverride: provider.fullPromptOverride,
    correction: null,
  };
  const estimatedNeurons =
    ESTIMATED_OUTPUT_NEURONS +
    Math.ceil(
      (
        input.title.length +
        input.excerpt.length +
        input.link.length +
        input.personalInstructions.length +
        (input.fullPromptOverride?.length ?? 0) +
        input.registry.reduce((sum, entry) => sum + entry.name.length + 8, 0)
      ) / 4,
    );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (provider.active.provider === "workers-ai") {
      await assertWorkersAiBudget(
        namespace,
        workersAiDailySoftLimit,
        estimatedNeurons,
        now,
      );
    }
    try {
      const result = await organizer.organize({
        ...input,
        correction:
          attempt === 0 ? null : "The prior output failed schema validation. Correct every field.",
      });
      if (provider.active.provider === "workers-ai") {
        await recordWorkersAiCall(namespace, estimatedNeurons, now);
      }
      return result;
    } catch (error) {
      if (
        provider.active.provider === "workers-ai" &&
        error instanceof OrganizerError &&
        error.kind === "schema"
      ) {
        await recordWorkersAiCall(namespace, estimatedNeurons, now);
      }
      if (!(error instanceof OrganizerError) || error.kind !== "schema" || attempt === 1) {
        throw error;
      }
    }
  }
  throw new OrganizerError("schema", "invalid_schema", "Invalid organization result");
}

async function assertWorkersAiBudget(
  namespace: KVNamespace,
  softLimit: number,
  estimatedNeurons: number,
  now: Date,
): Promise<void> {
  const utcDate = now.toISOString().slice(0, 10);
  const store = new OperationalStateStore(namespace);
  const usage = await store.getAiUsage(utcDate);
  if (usage.estimatedNeurons + estimatedNeurons > softLimit) {
    const reset = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
    throw new BudgetDeferredError(reset);
  }
}

async function recordWorkersAiCall(
  namespace: KVNamespace,
  estimatedNeurons: number,
  now: Date,
): Promise<void> {
  const utcDate = now.toISOString().slice(0, 10);
  const store = new OperationalStateStore(namespace);
  const usage = await store.getAiUsage(utcDate);
  await store.putAiUsage({
    ...usage,
    estimatedNeurons: usage.estimatedNeurons + estimatedNeurons,
    calls: usage.calls + 1,
    lastUpdatedAt: now.toISOString(),
  });
}

async function recordItemFailure(
  namespace: KVNamespace,
  raindrop: OrganizeRaindropGateway,
  reviewFolderId: number,
  bookmark: RaindropItem,
  registry: RegistryState,
  maxAttempts: number,
  reason: string,
): Promise<OrganizeOutcome> {
  const now = new Date().toISOString();
  const previous = registry.attempts[bookmark.id.toString()];
  const count = (previous?.count ?? 0) + 1;
  const nextRegistry: RegistryState = {
    ...registry,
    attempts: {
      ...registry.attempts,
      [bookmark.id.toString()]: {
        count,
        lastReason: reason,
        lastAttemptAt: now,
      },
    },
    updatedAt: now,
  };
  await new OperationalStateStore(namespace).putRegistry(nextRegistry);
  await clearDispatchLease(namespace, bookmark.id);
  if (count < maxAttempts) return { outcome: "item_retry", reason };

  const note = appendReviewReason(
    ensurePreservationBlock(bookmark.note, bookmark.link, bookmark.excerpt),
    reason,
  );
  if (note.length > 10_000) return { outcome: "item_retry", reason: "note_limit" };
  try {
    await raindrop.updateRaindrop(bookmark.id, {
      collectionId: reviewFolderId,
      tags: bookmark.tags.slice(0, 8),
      excerpt: bookmark.excerpt,
      note,
    });
  } catch (error) {
    return raindropTransient(namespace, "review_write_failed", error);
  }
  const latest = await new OperationalStateStore(namespace).getRegistry();
  if (latest !== null) {
    const attempts = Object.fromEntries(
      Object.entries(latest.attempts).filter(
        ([attemptId]) => attemptId !== bookmark.id.toString(),
      ),
    );
    await new OperationalStateStore(namespace).putRegistry({
      ...latest,
      attempts,
      updatedAt: new Date().toISOString(),
    });
  }
  return { outcome: "reviewed" };
}

async function mergeRegistryAfterSuccess(
  store: OperationalStateStore,
  registry: RegistryState,
  bookmarkId: number,
  tags: string[],
  now: string,
): Promise<void> {
  const entries = { ...registry.tags };
  for (const tag of tags) {
    const current = entries[tag];
    entries[tag] =
      current === undefined
        ? { count: 1, firstUsedAt: now, lastUsedAt: now }
        : { ...current, count: current.count + 1, lastUsedAt: now };
  }
  const attempts = Object.fromEntries(
    Object.entries(registry.attempts).filter(
      ([attemptId]) => attemptId !== bookmarkId.toString(),
    ),
  );
  await store.putRegistry({
    ...registry,
    tags: entries,
    attempts,
    updatedAt: now,
    source: "automation",
  });
}

async function pauseSystemically(
  namespace: KVNamespace,
  bookmarkId: number,
  reason: string,
): Promise<OrganizeOutcome> {
  const store = new OperationalStateStore(namespace);
  const current = await store.getPipeline();
  if (!current.paused) {
    await store.putPipeline({
      ...current,
      paused: true,
      pauseReason: reason,
      pausedAt: new Date().toISOString(),
      revision: current.revision + 1,
    });
  }
  await clearDispatchLease(namespace, bookmarkId);
  return { outcome: "systemic", reason };
}

async function deferForBudget(namespace: KVNamespace, retryAt: string): Promise<void> {
  const store = new OperationalStateStore(namespace);
  const current = await store.getPipeline();
  await store.putPipeline({
    ...current,
    deferredUntil: retryAt,
    deferredReason: "workers_ai_daily_budget",
    revision: current.revision + 1,
  });
}

async function deferForProvider(namespace: KVNamespace, retryAt: string): Promise<void> {
  const store = new OperationalStateStore(namespace);
  const current = await store.getPipeline();
  await store.putPipeline({
    ...current,
    deferredUntil: retryAt,
    deferredReason: "provider_rate_limit",
    revision: current.revision + 1,
  });
}

async function raindropTransient(
  namespace: KVNamespace,
  reason: string,
  error: unknown,
): Promise<OrganizeOutcome> {
  if (
    error instanceof RaindropHttpError &&
    error.status === 429 &&
    error.retryAt !== null
  ) {
    const store = new OperationalStateStore(namespace);
    const current = await store.getPipeline();
    await store.putPipeline({
      ...current,
      deferredUntil: error.retryAt,
      deferredReason: "raindrop_rate_limit",
      revision: current.revision + 1,
    });
    return { outcome: "transient", reason, retryAt: error.retryAt };
  }
  return { outcome: "transient", reason };
}

class BudgetDeferredError extends Error {
  override readonly name = "BudgetDeferredError";
  constructor(readonly retryAt: string) {
    super("Workers AI daily soft budget reached");
  }
}
