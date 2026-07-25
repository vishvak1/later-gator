import type {
  RaindropCollection,
  RaindropPage,
  RaindropUser,
} from "../adapters/raindrop-client";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { FOLDER_NAMES, SEED_TAGS } from "../domain/seed";
import type {
  FolderName,
  OnboardingState,
  RegistryState,
} from "../domain/schemas";

const UNSORTED_COLLECTION_ID = -1;
const PAGE_SIZE = 50;

export interface OnboardingAccountCheck {
  mode: "fresh" | "existing";
  raindropUserId: number;
  raindropUserName: string;
  bookmarkCount: number;
  userFolderCount: number;
  actions: string[];
}

export interface OnboardingRaindropGateway {
  getCurrentUser(): Promise<RaindropUser>;
  listCollections(): Promise<RaindropCollection[]>;
  countRaindrops(collectionId: number): Promise<number>;
  listRaindrops(
    collectionId: number,
    options?: { page?: number; perPage?: number },
  ): Promise<RaindropPage>;
  moveRaindrops(
    sourceCollectionId: number,
    ids: number[],
    destinationCollectionId: number,
  ): Promise<void>;
  clearRaindropTags(collectionId: number, ids: number[]): Promise<void>;
  deleteCollection(id: number): Promise<void>;
  createCollection(title: string): Promise<RaindropCollection>;
  getFilters(collectionId: number): Promise<{ untaggedCount: number }>;
}

export interface OnboardingFaultInjector {
  afterMutation(operation: string): Promise<void>;
}

const NO_FAULTS: OnboardingFaultInjector = {
  afterMutation: () => Promise.resolve(),
};

export async function checkOnboardingAccount(
  raindrop: OnboardingRaindropGateway,
): Promise<OnboardingAccountCheck> {
  const user = await raindrop.getCurrentUser();
  const [collections, bookmarkCount] = await Promise.all([
    raindrop.listCollections(),
    raindrop.countRaindrops(0),
  ]);
  const owned = ownedCollections(collections, user.id);
  const mode = bookmarkCount === 0 && owned.length === 0 ? "fresh" : "existing";
  return {
    mode,
    raindropUserId: user.id,
    raindropUserName: user.fullName,
    bookmarkCount,
    userFolderCount: owned.length,
    actions:
      mode === "fresh"
        ? ["Create eight Later Gator folders", "Initialize the seed tag registry"]
        : [
            "Move every bookmark from owned folders to Unsorted",
            "Clear all tags from bookmarks in Unsorted",
            "Delete each verified-empty owned folder",
            "Create eight Later Gator folders",
            "Initialize the seed tag registry",
          ],
  };
}

export async function startOnboarding(
  namespace: KVNamespace,
  raindrop: OnboardingRaindropGateway,
  expectedAccountUserId?: number,
): Promise<OnboardingState> {
  const store = new OnboardingStateStore(namespace);
  const current = await store.get();
  if (current.status === "complete" || current.status === "in_progress") {
    const user = await raindrop.getCurrentUser();
    if (
      current.accountUserId !== user.id ||
      (expectedAccountUserId !== undefined && user.id !== expectedAccountUserId)
    ) {
      throw new OnboardingAccountMismatchError();
    }
    return current;
  }

  const check = await checkOnboardingAccount(raindrop);
  if (
    expectedAccountUserId !== undefined &&
    check.raindropUserId !== expectedAccountUserId
  ) {
    throw new OnboardingAccountMismatchError();
  }
  const next: OnboardingState = {
    schemaVersion: 1,
    status: "in_progress",
    accountUserId: check.raindropUserId,
    mode: check.mode,
    currentStep: check.mode === "fresh" ? "create_folders" : "move_to_unsorted",
    startedAt: new Date().toISOString(),
    completedAt: null,
    cursor: null,
    folderIds: {},
    seedVersion: null,
    revision: current.revision + 1,
  };
  await store.put(next);
  return next;
}

export class OnboardingAccountMismatchError extends Error {
  override readonly name = "OnboardingAccountMismatchError";

  constructor() {
    super("The connected Raindrop account changed after validation");
  }
}

export async function continueOnboarding(
  namespace: KVNamespace,
  raindrop: OnboardingRaindropGateway,
  seedVersion: string,
  faults: OnboardingFaultInjector = NO_FAULTS,
): Promise<OnboardingState> {
  const store = new OnboardingStateStore(namespace);
  const current = await store.get();
  if (current.status !== "in_progress" || current.accountUserId === null) return current;

  const user = await raindrop.getCurrentUser();
  if (user.id !== current.accountUserId) {
    throw new Error("Raindrop account does not match the onboarding account");
  }

  switch (current.currentStep) {
    case "move_to_unsorted":
      return moveOneChunk(store, current, raindrop, faults);
    case "clear_tags":
      return clearOneTagChunk(store, current, raindrop, faults);
    case "delete_collections":
      return deleteOneCollection(store, current, raindrop, faults);
    case "create_folders":
      return createOneFolder(store, current, raindrop, faults);
    case "initialize_registry":
      return initializeRegistry(store, current, seedVersion, faults);
    case "complete":
      return completeOnboarding(store, current, seedVersion);
    case null:
      throw new Error("In-progress onboarding has no current step");
  }
}

async function moveOneChunk(
  store: OnboardingStateStore,
  current: OnboardingState,
  raindrop: OnboardingRaindropGateway,
  faults: OnboardingFaultInjector,
): Promise<OnboardingState> {
  const collections = ownedCollections(
    await raindrop.listCollections(),
    current.accountUserId ?? 0,
  );
  for (const collection of collections) {
    const page = await raindrop.listRaindrops(collection.id, {
      page: 0,
      perPage: PAGE_SIZE,
    });
    if (page.items.length === 0) continue;
    await raindrop.moveRaindrops(
      collection.id,
      page.items.map((item) => item.id),
      UNSORTED_COLLECTION_ID,
    );
    await faults.afterMutation("move_to_unsorted");
    return current;
  }
  return advance(store, current, "clear_tags", "0");
}

async function clearOneTagChunk(
  store: OnboardingStateStore,
  current: OnboardingState,
  raindrop: OnboardingRaindropGateway,
  faults: OnboardingFaultInjector,
): Promise<OnboardingState> {
  const pageNumber = parsePageCursor(current.cursor);
  const page = await raindrop.listRaindrops(UNSORTED_COLLECTION_ID, {
    page: pageNumber,
    perPage: PAGE_SIZE,
  });
  const taggedIds = page.items.filter((item) => item.tags.length > 0).map((item) => item.id);
  if (taggedIds.length > 0) {
    await raindrop.clearRaindropTags(UNSORTED_COLLECTION_ID, taggedIds);
    await faults.afterMutation("clear_tags");
  }

  if (page.items.length === PAGE_SIZE) {
    return update(store, current, { cursor: (pageNumber + 1).toString() });
  }

  const [filters, count] = await Promise.all([
    raindrop.getFilters(UNSORTED_COLLECTION_ID),
    raindrop.countRaindrops(UNSORTED_COLLECTION_ID),
  ]);
  if (filters.untaggedCount !== count) {
    return update(store, current, { cursor: "0" });
  }
  return advance(store, current, "delete_collections", null);
}

async function deleteOneCollection(
  store: OnboardingStateStore,
  current: OnboardingState,
  raindrop: OnboardingRaindropGateway,
  faults: OnboardingFaultInjector,
): Promise<OnboardingState> {
  const collections = ownedCollections(
    await raindrop.listCollections(),
    current.accountUserId ?? 0,
  );
  if (collections.length === 0) {
    return advance(store, current, "create_folders", null);
  }

  const parentIds = new Set(
    collections.flatMap((collection) =>
      collection.parentId === null ? [] : [collection.parentId],
    ),
  );
  const leaf = collections.find((collection) => !parentIds.has(collection.id));
  if (leaf === undefined) throw new Error("Owned collection hierarchy contains a cycle");

  const verification = await raindrop.listRaindrops(leaf.id, { page: 0, perPage: 1 });
  if (leaf.count !== 0 || verification.items.length !== 0) {
    return advance(store, current, "move_to_unsorted", null);
  }

  await raindrop.deleteCollection(leaf.id);
  await faults.afterMutation("delete_collection");
  return current;
}

async function createOneFolder(
  store: OnboardingStateStore,
  current: OnboardingState,
  raindrop: OnboardingRaindropGateway,
  faults: OnboardingFaultInjector,
): Promise<OnboardingState> {
  const missing = FOLDER_NAMES.find((name) => current.folderIds[name] === undefined);
  if (missing === undefined) {
    return advance(store, current, "initialize_registry", null);
  }

  const collections = ownedCollections(
    await raindrop.listCollections(),
    current.accountUserId ?? 0,
  );
  const recovered = collections.find(
    (collection) => collection.parentId === null && collection.title === missing,
  );
  const folder = recovered ?? (await raindrop.createCollection(missing));
  if (recovered === undefined) await faults.afterMutation("create_folder");
  return update(store, current, {
    folderIds: { ...current.folderIds, [missing]: folder.id },
  });
}

async function initializeRegistry(
  store: OnboardingStateStore,
  current: OnboardingState,
  seedVersion: string,
  faults: OnboardingFaultInjector,
): Promise<OnboardingState> {
  const now = new Date().toISOString();
  const tags = Object.fromEntries(
    SEED_TAGS.map((tag) => [
      tag,
      { count: 0, firstUsedAt: now, lastUsedAt: now },
    ]),
  );
  const registry: RegistryState = {
    schemaVersion: 1,
    seedVersion,
    tags,
    attempts: {},
    updatedAt: now,
    source: "onboarding",
  };
  await store.putRegistry(registry);
  await faults.afterMutation("initialize_registry");
  return advance(store, current, "complete", null);
}

async function completeOnboarding(
  store: OnboardingStateStore,
  current: OnboardingState,
  seedVersion: string,
): Promise<OnboardingState> {
  for (const name of FOLDER_NAMES) {
    if (current.folderIds[name] === undefined) {
      throw new Error(`Onboarding folder ${name} is missing`);
    }
  }
  const next: OnboardingState = {
    ...current,
    status: "complete",
    currentStep: "complete",
    completedAt: new Date().toISOString(),
    cursor: null,
    seedVersion,
    revision: current.revision + 1,
  };
  await store.put(next);
  return next;
}

function ownedCollections(
  collections: RaindropCollection[],
  userId: number,
): RaindropCollection[] {
  return collections.filter(
    (collection) => collection.userId === userId && collection.accessLevel === 4,
  );
}

function parsePageCursor(cursor: string | null): number {
  if (cursor === null || !/^\d+$/u.test(cursor)) return 0;
  const page = Number(cursor);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

async function advance(
  store: OnboardingStateStore,
  current: OnboardingState,
  step: NonNullable<OnboardingState["currentStep"]>,
  cursor: string | null,
): Promise<OnboardingState> {
  return update(store, current, { currentStep: step, cursor });
}

async function update(
  store: OnboardingStateStore,
  current: OnboardingState,
  changes: Partial<Pick<OnboardingState, "currentStep" | "cursor" | "folderIds">>,
): Promise<OnboardingState> {
  const next: OnboardingState = {
    ...current,
    ...changes,
    revision: current.revision + 1,
  };
  await store.put(next);
  return next;
}

export function folderActions(check: OnboardingAccountCheck): string[] {
  return [...check.actions];
}

export function isFolderName(value: string): value is FolderName {
  return FOLDER_NAMES.some((name) => name === value);
}
