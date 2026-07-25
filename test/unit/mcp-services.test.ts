import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OnboardingStateStore } from "../../src/adapters/onboarding-state-store";
import { OperationalStateStore } from "../../src/adapters/operational-state-store";
import {
  getContext,
  searchBookmarks,
  type McpRaindropGateway,
} from "../../src/application/mcp-services";

describe("MCP application services", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("registry:v1"),
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
      folderIds: { Articles: 2, "Need for Review": 8 },
      seedVersion: "v1",
      revision: 1,
    });
    await new OperationalStateStore(env.STATE).putRegistry({
      schemaVersion: 1,
      seedVersion: "v1",
      tags: {
        "machine-learning": {
          count: 3,
          firstUsedAt: "2026-07-25T00:00:00.000Z",
          lastUsedAt: "2026-07-25T00:00:00.000Z",
        },
      },
      attempts: {},
      updatedAt: "2026-07-25T00:00:00.000Z",
      source: "onboarding",
    });
  });

  it("returns the configured local date and actual vocabulary", async () => {
    await expect(
      getContext(
        env.STATE,
        "Asia/Kolkata",
        new Date("2026-07-25T20:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      status: "ok",
      today: "2026-07-26",
      timezone: "Asia/Kolkata",
      tags: [{ name: "machine-learning", count: 3 }],
    });
  });

  it("returns structured unknown-tag guidance without rewriting the query", async () => {
    const result = await searchBookmarks(env.STATE, new FakeRaindrop(0), {
      tags: ["machine"],
      limit: 100,
    });
    expect(result).toMatchObject({
      status: "invalid_request",
      error: "unknown_tags",
      unknown: ["machine"],
      suggestions: ["machine-learning"],
    });
  });

  it("uses the filters total and caps broad result retrieval at 25", async () => {
    const raindrop = new FakeRaindrop(342);
    const result = await searchBookmarks(env.STATE, raindrop, {
      text: "distributed systems",
      limit: 100,
    });
    expect(result).toMatchObject({
      status: "too_many_results",
      total: 342,
      returned: 25,
    });
    expect(raindrop.lastOptions).toMatchObject({
      search: "distributed systems",
      perPage: 25,
    });
  });
});

class FakeRaindrop implements McpRaindropGateway {
  lastOptions: Parameters<McpRaindropGateway["listRaindrops"]>[1];

  constructor(private readonly total: number) {}

  getCurrentUser() {
    return Promise.resolve({ id: 42, fullName: "Owner" });
  }

  countRaindrops() {
    return Promise.resolve(this.total);
  }

  getFilters() {
    return Promise.resolve({
      untaggedCount: 0,
      tags: [],
      totalByType: this.total,
    });
  }

  listRaindrops(
    _collectionId: number,
    options?: Parameters<McpRaindropGateway["listRaindrops"]>[1],
  ) {
    this.lastOptions = options;
    const count = options?.perPage ?? 50;
    return Promise.resolve({
      totalCount: this.total,
      items: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        collectionId: 2,
        title: `Result ${index.toString()}`,
        link: `https://example.test/${index.toString()}`,
        excerpt: "Description",
        note: "",
        tags: ["machine-learning"],
        created: "2026-07-25T00:00:00.000Z",
        lastUpdate: null,
        type: "article",
      })),
    });
  }
}
