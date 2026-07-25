import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminStateStore } from "../../src/adapters/admin-state-store";
import { OnboardingStateStore } from "../../src/adapters/onboarding-state-store";
import { OperationalStateStore } from "../../src/adapters/operational-state-store";
import { resyncRegistryIfDue } from "../../src/application/registry-resync";

describe("registry resync", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("pipeline:v1"),
      env.STATE.delete("registry:v1"),
      env.STATE.delete("maintenance:v1"),
      env.STATE.delete("activity:v1"),
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
      folderIds: { Articles: 2, Code: 4 },
      seedVersion: "v1",
      revision: 1,
    });
    await new OperationalStateStore(env.STATE).putRegistry({
      schemaVersion: 1,
      seedVersion: "v1",
      tags: {},
      attempts: {},
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "onboarding",
    });
  });

  it("rebuilds counts from managed Raindrop folders once per day", async () => {
    const admin = new AdminStateStore(env.STATE, 10);
    let calls = 0;
    const gateway = {
      getFilters: () => {
        calls += 1;
        return Promise.resolve({
          untaggedCount: 0,
          tags: [{ name: "machine-learning", count: 2 }],
          totalByType: 2,
        });
      },
    };
    await expect(
      resyncRegistryIfDue(
        env.STATE,
        gateway,
        new Date("2026-07-25T12:00:00.000Z"),
        admin,
      ),
    ).resolves.toBe("resynced");
    expect(calls).toBe(2);
    expect(
      (await new OperationalStateStore(env.STATE).getRegistry())?.tags[
        "machine-learning"
      ]?.count,
    ).toBe(4);
    await expect(
      resyncRegistryIfDue(
        env.STATE,
        gateway,
        new Date("2026-07-25T13:00:00.000Z"),
        admin,
      ),
    ).resolves.toBe("not_due");
    expect(calls).toBe(2);
  });
});
