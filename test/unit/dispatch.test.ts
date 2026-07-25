import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchUnsorted,
  type DispatchQueueGateway,
  type DispatchRaindropGateway,
} from "../../src/application/dispatch";
import { OnboardingStateStore } from "../../src/adapters/onboarding-state-store";
import { OperationalStateStore } from "../../src/adapters/operational-state-store";
import type { DispatchMessage } from "../../src/domain/schemas";

describe("scheduled discovery", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("pipeline:v1"),
      env.STATE.delete("dispatch:v1"),
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
      folderIds: { "Need for Review": 8 },
      seedVersion: "v1",
      revision: 1,
    });
  });

  it("enqueues only IDs and records leases before sending", async () => {
    const queue = new FakeQueue();
    const result = await dispatchUnsorted(
      env.STATE,
      queue,
      new FakeRaindrop(42, [bookmark(101), bookmark(102)]),
      1,
      new Date("2026-07-25T12:00:00.000Z"),
    );

    expect(result).toEqual({ outcome: "enqueued", discovered: 2, enqueued: 1 });
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]?.body).toEqual(
      expect.objectContaining({ bookmarkId: 101, raindropUserId: 42 }),
    );
    expect(JSON.stringify(queue.messages[0])).not.toContain("example.test");
    const dispatch = await new OperationalStateStore(env.STATE).getDispatch();
    expect(dispatch.leases["101"]).toBeDefined();
  });

  it("refuses to enqueue when the connected account does not match", async () => {
    const queue = new FakeQueue();
    await expect(
      dispatchUnsorted(env.STATE, queue, new FakeRaindrop(99, [bookmark(101)]), 10),
    ).resolves.toMatchObject({ outcome: "account_mismatch", enqueued: 0 });
    expect(queue.messages).toHaveLength(0);
  });

  it("does not duplicate a bookmark with a live lease", async () => {
    const queue = new FakeQueue();
    const raindrop = new FakeRaindrop(42, [bookmark(101)]);
    const now = new Date("2026-07-25T12:00:00.000Z");
    await dispatchUnsorted(env.STATE, queue, raindrop, 10, now);
    await expect(dispatchUnsorted(env.STATE, queue, raindrop, 10, now)).resolves.toMatchObject({
      outcome: "all_leased",
      enqueued: 0,
    });
    expect(queue.messages).toHaveLength(1);
  });
});

class FakeQueue implements DispatchQueueGateway {
  readonly messages: MessageSendRequest<DispatchMessage>[] = [];

  sendBatch(messages: MessageSendRequest<DispatchMessage>[]): Promise<unknown> {
    this.messages.push(...messages);
    return Promise.resolve(undefined);
  }
}

class FakeRaindrop implements DispatchRaindropGateway {
  constructor(
    private readonly userId: number,
    private readonly items: ReturnType<typeof bookmark>[],
  ) {}

  getCurrentUser() {
    return Promise.resolve({ id: this.userId, fullName: "Owner" });
  }

  listRaindrops() {
    return Promise.resolve({ items: this.items, totalCount: this.items.length });
  }
}

function bookmark(id: number) {
  return {
    id,
    collectionId: -1,
    title: `Bookmark ${id.toString()}`,
    link: `https://example.test/${id.toString()}`,
    excerpt: "",
    note: "",
    tags: [],
    created: "2026-07-25T00:00:00.000Z",
    lastUpdate: null,
    type: "link",
  };
}
