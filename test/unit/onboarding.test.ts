import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkOnboardingAccount,
  continueOnboarding,
  startOnboarding,
  type OnboardingRaindropGateway,
} from "../../src/application/onboarding";
import type {
  RaindropCollection,
  RaindropItem,
  RaindropPage,
} from "../../src/adapters/raindrop-client";
import { FOLDER_NAMES } from "../../src/domain/seed";

describe("onboarding workflow", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("registry:v1"),
    ]);
  });

  it("classifies only a completely empty account as fresh", async () => {
    const fresh = new FakeRaindrop([], []);
    await expect(checkOnboardingAccount(fresh)).resolves.toMatchObject({
      mode: "fresh",
      bookmarkCount: 0,
      userFolderCount: 0,
    });

    const existing = new FakeRaindrop([], [item(1, -1, [])]);
    await expect(checkOnboardingAccount(existing)).resolves.toMatchObject({
      mode: "existing",
    });
  });

  it("does not mutate onboarding state when the validated account changed", async () => {
    const raindrop = new FakeRaindrop([], []);
    await expect(startOnboarding(env.STATE, raindrop, 999)).rejects.toThrow(
      "changed after validation",
    );
    await expect(env.STATE.get("onboarding:v1")).resolves.toBeNull();
  });

  it("completes fresh onboarding by creating only the seed folders and registry", async () => {
    const raindrop = new FakeRaindrop([], []);
    await startOnboarding(env.STATE, raindrop);
    const state = await finish(raindrop);

    expect(state.status).toBe("complete");
    expect(raindrop.collections.map((collection) => collection.title)).toEqual(
      [...FOLDER_NAMES],
    );
    expect(raindrop.items).toHaveLength(0);
    const registry = await env.STATE.get("registry:v1");
    expect(registry).toContain('"machine-learning"');
  });

  it("moves, clears, verifies, deletes, and seeds an existing account", async () => {
    const raindrop = new FakeRaindrop(
      [
        collection(11, "Old root", null, 1),
        collection(12, "Old child", 11, 1),
      ],
      [
        item(101, 11, ["old-tag"]),
        item(102, 12, ["another-tag"]),
        item(103, -1, ["unsorted-tag"]),
      ],
    );
    await startOnboarding(env.STATE, raindrop);
    const state = await finish(raindrop);

    expect(state.status).toBe("complete");
    expect(raindrop.items.every((bookmark) => bookmark.collectionId === -1)).toBe(true);
    expect(raindrop.items.every((bookmark) => bookmark.tags.length === 0)).toBe(true);
    expect(raindrop.collections.map((folder) => folder.title)).toEqual([...FOLDER_NAMES]);
    expect(raindrop.deletedIds).toEqual(expect.arrayContaining([11, 12]));
  });

  it("recovers without duplicate folders when interrupted after a create", async () => {
    const raindrop = new FakeRaindrop([], []);
    await startOnboarding(env.STATE, raindrop);
    let injected = false;
    await expect(
      continueOnboarding(env.STATE, raindrop, "v1", {
        afterMutation(operation) {
          if (!injected && operation === "create_folder") {
            injected = true;
            return Promise.reject(new Error("injected crash"));
          }
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("injected crash");

    const state = await finish(raindrop);
    expect(state.status).toBe("complete");
    expect(
      raindrop.collections.filter((folder) => folder.title === FOLDER_NAMES[0]),
    ).toHaveLength(1);
  });

  it("rechecks an apparently empty folder immediately before deletion", async () => {
    const raindrop = new FakeRaindrop([collection(11, "Old", null, 0)], []);
    await startOnboarding(env.STATE, raindrop);
    await continueUntilStep(raindrop, "delete_collections");
    raindrop.items.push(item(999, 11, []));

    const next = await continueOnboarding(env.STATE, raindrop, "v1");
    expect(next.currentStep).toBe("move_to_unsorted");
    expect(raindrop.deletedIds).not.toContain(11);
  });
});

async function finish(raindrop: FakeRaindrop) {
  for (let index = 0; index < 100; index += 1) {
    const state = await continueOnboarding(env.STATE, raindrop, "v1");
    if (state.status === "complete") return state;
  }
  throw new Error("Onboarding did not complete");
}

async function continueUntilStep(
  raindrop: FakeRaindrop,
  target: "delete_collections",
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const state = await continueOnboarding(env.STATE, raindrop, "v1");
    if (state.currentStep === target) return;
  }
  throw new Error(`Onboarding did not reach ${target}`);
}

class FakeRaindrop implements OnboardingRaindropGateway {
  readonly deletedIds: number[] = [];
  private nextCollectionId = 1_000;

  constructor(
    readonly collections: RaindropCollection[],
    readonly items: RaindropItem[],
  ) {}

  getCurrentUser() {
    return Promise.resolve({ id: 42, fullName: "Test User" });
  }

  listCollections() {
    for (const folder of this.collections) {
      folder.count = this.items.filter((bookmark) => bookmark.collectionId === folder.id).length;
    }
    return Promise.resolve(this.collections.map((folder) => ({ ...folder })));
  }

  countRaindrops(collectionId: number) {
    return Promise.resolve(
      collectionId === 0
        ? this.items.length
        : this.items.filter((bookmark) => bookmark.collectionId === collectionId).length,
    );
  }

  listRaindrops(
    collectionId: number,
    options: { page?: number; perPage?: number } = {},
  ): Promise<RaindropPage> {
    const page = options.page ?? 0;
    const perPage = options.perPage ?? 50;
    const matching = this.items.filter(
      (bookmark) => bookmark.collectionId === collectionId,
    );
    return Promise.resolve({
      items: matching.slice(page * perPage, page * perPage + perPage),
      totalCount: matching.length,
    });
  }

  moveRaindrops(_sourceCollectionId: number, ids: number[], destinationCollectionId: number) {
    for (const bookmark of this.items) {
      if (ids.includes(bookmark.id)) bookmark.collectionId = destinationCollectionId;
    }
    return Promise.resolve();
  }

  clearRaindropTags(_collectionId: number, ids: number[]) {
    for (const bookmark of this.items) {
      if (ids.includes(bookmark.id)) bookmark.tags = [];
    }
    return Promise.resolve();
  }

  deleteCollection(id: number) {
    const index = this.collections.findIndex((folder) => folder.id === id);
    if (index >= 0) this.collections.splice(index, 1);
    this.deletedIds.push(id);
    return Promise.resolve();
  }

  createCollection(title: string) {
    const created = collection(this.nextCollectionId, title, null, 0);
    this.nextCollectionId += 1;
    this.collections.push(created);
    return Promise.resolve({ ...created });
  }

  getFilters(collectionId: number) {
    return Promise.resolve({
      untaggedCount: this.items.filter(
        (bookmark) => bookmark.collectionId === collectionId && bookmark.tags.length === 0,
      ).length,
    });
  }
}

function collection(
  id: number,
  title: string,
  parentId: number | null,
  count: number,
): RaindropCollection {
  return { id, title, parentId, count, userId: 42, accessLevel: 4 };
}

function item(id: number, collectionId: number, tags: string[]): RaindropItem {
  return {
    id,
    collectionId,
    tags,
    title: `Bookmark ${id.toString()}`,
    link: `https://example.test/${id.toString()}`,
    excerpt: "",
    note: "",
    created: "2026-07-25T00:00:00.000Z",
    lastUpdate: null,
    type: "link",
  };
}
