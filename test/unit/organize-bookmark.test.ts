import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Organizer } from "../../src/adapters/organizer";
import { OrganizerError } from "../../src/adapters/organizer";
import { OnboardingStateStore } from "../../src/adapters/onboarding-state-store";
import { OperationalStateStore } from "../../src/adapters/operational-state-store";
import type { RaindropItem } from "../../src/adapters/raindrop-client";
import {
  organizeBookmark,
  type OrganizeRaindropGateway,
} from "../../src/application/organize-bookmark";
import type { ProviderConfigState, RegistryState } from "../../src/domain/schemas";

describe("bookmark organization", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("pipeline:v1"),
      env.STATE.delete("dispatch:v1"),
      env.STATE.delete("registry:v1"),
      env.STATE.delete("ai-usage:2026-07-25"),
    ]);
    await new OnboardingStateStore(env.STATE).put({
      schemaVersion: 1,
      status: "complete",
      accountUserId: 42,
      mode: "fresh",
      currentStep: null,
      startedAt: "2026-07-25T00:00:00.000Z",
      completedAt: "2026-07-25T00:01:00.000Z",
      cursor: null,
      folderIds: {
        "Social Posts": 1,
        Articles: 2,
        "Videos & Talks": 3,
        Code: 4,
        "Docs & Reference": 5,
        Papers: 6,
        "Websites & Apps": 7,
        "Need for Review": 8,
      },
      seedVersion: "v1",
      revision: 1,
    });
    await new OperationalStateStore(env.STATE).putRegistry(registry());
  });

  it("updates the original bookmark in place and preserves its source fields", async () => {
    const raindrop = new FakeRaindrop(bookmark());
    const outcome = await organizeBookmark(
      env.STATE,
      raindrop,
      fixedOrganizer(),
      provider("openai"),
      101,
      3,
      10_000,
      new Date("2026-07-25T12:00:00.000Z"),
    );

    expect(outcome).toEqual({ outcome: "processed" });
    expect(raindrop.updates).toHaveLength(1);
    expect(raindrop.updates[0]).toMatchObject({
      id: 101,
      update: {
        collectionId: 2,
        tags: ["machine-learning"],
        excerpt: "A concise reference.",
      },
    });
    expect(raindrop.updates[0]?.update.note).toContain("https://example.test/source");
    expect(raindrop.updates[0]?.update.note).toContain("Original summary");
  });

  it("routes a low-confidence result to review with a visible reason", async () => {
    const raindrop = new FakeRaindrop(bookmark());
    const organizer: Organizer = {
      organize: () =>
        Promise.resolve({
          tags: ["machine learning"],
          description: "Needs a human decision.",
          folder: "Articles",
          confidence: "low",
          notes: "Ambiguous source type",
        }),
    };
    await expect(
      organizeBookmark(
        env.STATE,
        raindrop,
        organizer,
        provider("anthropic"),
        101,
        3,
        10_000,
      ),
    ).resolves.toEqual({ outcome: "reviewed" });
    expect(raindrop.updates[0]?.update.collectionId).toBe(8);
    expect(raindrop.updates[0]?.update.note).toContain("Ambiguous source type");
  });

  it("retries one malformed model response before accepting the correction", async () => {
    let calls = 0;
    const organizer: Organizer = {
      organize: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new OrganizerError("schema", "invalid_schema", "Malformed"),
          );
        }
        return fixedOrganizer().organize({
          title: "",
          excerpt: "",
          link: "",
          registry: [],
          personalInstructions: "",
          correction: null,
        });
      },
    };
    const raindrop = new FakeRaindrop(bookmark());
    await expect(
      organizeBookmark(
        env.STATE,
        raindrop,
        organizer,
        provider("openai"),
        101,
        3,
        10_000,
      ),
    ).resolves.toEqual({ outcome: "processed" });
    expect(calls).toBe(2);
  });

  it("defers Workers AI cleanly when the daily soft budget is exhausted", async () => {
    const store = new OperationalStateStore(env.STATE);
    await store.putAiUsage({
      schemaVersion: 1,
      utcDate: "2026-07-25",
      estimatedNeurons: 700,
      calls: 1,
      lastUpdatedAt: "2026-07-25T11:00:00.000Z",
    });
    const raindrop = new FakeRaindrop(bookmark());
    await expect(
      organizeBookmark(
        env.STATE,
        raindrop,
        fixedOrganizer(),
        provider("workers-ai"),
        101,
        3,
        1_000,
        new Date("2026-07-25T12:00:00.000Z"),
      ),
    ).resolves.toEqual({
      outcome: "deferred_budget",
      retryAt: "2026-07-26T00:00:00.000Z",
    });
    expect(raindrop.updates).toHaveLength(0);
  });

  it("does not spend the Workers AI soft budget on a failed provider request", async () => {
    const raindrop = new FakeRaindrop(bookmark());
    const transientOrganizer: Organizer = {
      organize: () =>
        Promise.reject(
          new OrganizerError("transient", "workers_ai_failure", "Workers AI failed"),
        ),
    };
    const now = new Date("2026-07-25T12:00:00.000Z");

    await expect(
      organizeBookmark(
        env.STATE,
        raindrop,
        transientOrganizer,
        provider("workers-ai"),
        101,
        3,
        1_000,
        now,
      ),
    ).resolves.toEqual({ outcome: "transient", reason: "workers_ai_failure" });
    await expect(
      new OperationalStateStore(env.STATE).getAiUsage("2026-07-25"),
    ).resolves.toMatchObject({ estimatedNeurons: 0, calls: 0 });

    await expect(
      organizeBookmark(
        env.STATE,
        raindrop,
        fixedOrganizer(),
        provider("workers-ai"),
        101,
        3,
        1_000,
        now,
      ),
    ).resolves.toEqual({ outcome: "processed" });
    await expect(
      new OperationalStateStore(env.STATE).getAiUsage("2026-07-25"),
    ).resolves.toMatchObject({ calls: 1 });
  });
});

class FakeRaindrop implements OrganizeRaindropGateway {
  readonly updates: {
    id: number;
    update: Parameters<OrganizeRaindropGateway["updateRaindrop"]>[1];
  }[] = [];

  constructor(private item: RaindropItem) {}

  getRaindrop() {
    return Promise.resolve({ ...this.item });
  }

  updateRaindrop(
    id: number,
    update: Parameters<OrganizeRaindropGateway["updateRaindrop"]>[1],
  ) {
    this.updates.push({ id, update });
    this.item = {
      ...this.item,
      collectionId: update.collectionId,
      tags: update.tags,
      excerpt: update.excerpt,
      note: update.note,
      link: update.link ?? this.item.link,
      title: update.title ?? this.item.title,
    };
    return Promise.resolve({ ...this.item });
  }
}

function fixedOrganizer(): Organizer {
  return {
    organize: () =>
      Promise.resolve({
        tags: ["Machine Learning"],
        description: "A concise reference.",
        folder: "Articles",
        confidence: "high",
        notes: null,
      }),
  };
}

function provider(name: "workers-ai" | "anthropic" | "openai"): ProviderConfigState {
  return {
    schemaVersion: 1,
    active: { provider: name, model: "test-model", promptRevision: 1 },
    candidate: null,
    candidateTestedAt: null,
    candidateTestSucceeded: false,
    personalInstructions: "",
    fullPromptOverride: null,
    revision: 1,
  };
}

function registry(): RegistryState {
  return {
    schemaVersion: 1,
    seedVersion: "v1",
    tags: {
      "machine-learning": {
        count: 0,
        firstUsedAt: "2026-07-25T00:00:00.000Z",
        lastUsedAt: "2026-07-25T00:00:00.000Z",
      },
    },
    attempts: {},
    updatedAt: "2026-07-25T00:00:00.000Z",
    source: "onboarding",
  };
}

function bookmark(): RaindropItem {
  return {
    id: 101,
    collectionId: -1,
    title: "Source",
    link: "https://example.test/source",
    excerpt: "Original summary",
    note: "My note",
    tags: [],
    created: "2026-07-25T00:00:00.000Z",
    lastUpdate: null,
    type: "link",
  };
}
