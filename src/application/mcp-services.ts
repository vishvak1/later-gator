import type {
  RaindropFilters,
  RaindropItem,
  RaindropPage,
  RaindropUser,
} from "../adapters/raindrop-client";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { OperationalStateStore } from "../adapters/operational-state-store";
import type { ProviderConfigState } from "../domain/schemas";
import { FOLDER_NAMES } from "../domain/seed";

export interface BookmarkSearchInput {
  text?: string;
  tags?: string[];
  folder?: (typeof FOLDER_NAMES)[number];
  from?: string;
  to?: string;
  limit: number;
}

export interface McpRaindropGateway {
  getCurrentUser(): Promise<RaindropUser>;
  countRaindrops(collectionId: number): Promise<number>;
  getFilters(collectionId: number, search?: string): Promise<RaindropFilters>;
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

export async function getContext(
  namespace: KVNamespace,
  timezone: string,
  now = new Date(),
) {
  const [onboarding, registry] = await Promise.all([
    new OnboardingStateStore(namespace).get(),
    new OperationalStateStore(namespace).getRegistry(),
  ]);
  if (onboarding.status !== "complete" || registry === null) {
    return { status: "unavailable" as const, reason: "onboarding_incomplete" };
  }
  return {
    status: "ok" as const,
    today: localDate(now, timezone),
    timezone,
    folders: [...FOLDER_NAMES],
    tags: Object.entries(registry.tags)
      .sort(([, left], [, right]) => right.count - left.count)
      .map(([name, entry]) => ({ name, count: entry.count })),
  };
}

export async function searchBookmarks(
  namespace: KVNamespace,
  raindrop: McpRaindropGateway,
  input: BookmarkSearchInput,
) {
  const [onboarding, registry] = await Promise.all([
    new OnboardingStateStore(namespace).get(),
    new OperationalStateStore(namespace).getRegistry(),
  ]);
  if (onboarding.status !== "complete" || registry === null) {
    return { status: "unavailable", total: 0, returned: 0, items: [] };
  }

  const unknown = (input.tags ?? []).filter((tag) => registry.tags[tag] === undefined);
  if (unknown.length > 0) {
    return {
      status: "invalid_request",
      total: 0,
      returned: 0,
      items: [],
      error: "unknown_tags",
      unknown,
      suggestions: Object.keys(registry.tags)
        .filter((tag) => unknown.some((value) => tag.startsWith(value) || value.startsWith(tag)))
        .slice(0, 10),
    };
  }

  const collectionId =
    input.folder === undefined ? 0 : onboarding.folderIds[input.folder];
  if (collectionId === undefined) {
    return { status: "unavailable", total: 0, returned: 0, items: [] };
  }
  const search = buildSearch(input);
  const filters = await raindrop.getFilters(collectionId, search);
  const total = filters.totalByType;
  const fetchLimit = total > 100 ? 25 : input.limit;
  const items: RaindropItem[] = [];
  for (let page = 0; page < Math.ceil(fetchLimit / 50); page += 1) {
    const result = await raindrop.listRaindrops(collectionId, {
      page,
      perPage: Math.min(50, fetchLimit - items.length),
      ...(search === undefined ? {} : { search }),
      sort: "-created",
    });
    items.push(...result.items);
    if (result.items.length < Math.min(50, fetchLimit - (items.length - result.items.length))) {
      break;
    }
  }
  const projected = items.slice(0, fetchLimit).map((item) => ({
    id: item.id,
    title: item.title,
    description: truncate(item.excerpt, 300),
    tags: item.tags,
    folder: folderForId(onboarding.folderIds, item.collectionId),
    created: item.created,
    url: item.link,
    domain: new URL(item.link).hostname,
  }));
  return total > 100
    ? {
        status: "too_many_results",
        total,
        returned: projected.length,
        suggestion: "Please refine your search.",
        items: projected,
      }
    : { status: "ok", total, returned: projected.length, items: projected };
}

export async function getPipelineStatus(
  namespace: KVNamespace,
  raindrop: McpRaindropGateway,
  provider: ProviderConfigState,
) {
  const [onboarding, pipeline, dispatch] = await Promise.all([
    new OnboardingStateStore(namespace).get(),
    new OperationalStateStore(namespace).getPipeline(),
    new OperationalStateStore(namespace).getDispatch(),
  ]);
  let accountMatch: boolean | null = null;
  let pendingUnsorted: number | null = null;
  if (onboarding.accountUserId !== null) {
    try {
      const user = await raindrop.getCurrentUser();
      accountMatch = user.id === onboarding.accountUserId;
      if (accountMatch) pendingUnsorted = await raindrop.countRaindrops(-1);
    } catch {
      accountMatch = false;
    }
  }
  return {
    status: "ok",
    onboarding: onboarding.status,
    accountMatch,
    paused: pipeline.paused,
    pauseReason: pipeline.pauseReason,
    mode: pipeline.mode,
    deferredUntil: pipeline.deferredUntil,
    lastRun: pipeline.lastRun,
    pendingUnsorted,
    leased: Object.keys(dispatch.leases).length,
    seedVersion: onboarding.seedVersion,
    provider: provider.active.provider,
    model: provider.active.model,
  };
}

function buildSearch(input: BookmarkSearchInput): string | undefined {
  const parts: string[] = [];
  if (input.text !== undefined) parts.push(input.text);
  for (const tag of input.tags ?? []) parts.push(`#${quoteSearch(tag)}`);
  if (input.from !== undefined) parts.push(`created:>${input.from}`);
  if (input.to !== undefined) parts.push(`created:<${input.to}`);
  return parts.length === 0 ? undefined : parts.join(" ");
}

function quoteSearch(value: string): string {
  return value.includes(" ") ? `"${value.replaceAll('"', "")}"` : value;
}

function folderForId(
  folderIds: Record<string, number | undefined>,
  id: number,
): string | null {
  return Object.entries(folderIds).find(([, folderId]) => folderId === id)?.[0] ?? null;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year ?? "0000"}-${values.month ?? "00"}-${values.day ?? "00"}`;
}
