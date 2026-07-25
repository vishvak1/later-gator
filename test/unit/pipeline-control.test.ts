import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OnboardingStateStore } from "../../src/adapters/onboarding-state-store";
import { OperationalStateStore } from "../../src/adapters/operational-state-store";
import { resumePipeline } from "../../src/application/pipeline-control";

describe("pipeline resume", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("pipeline:v1"),
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
      folderIds: {},
      seedVersion: "v1",
      revision: 1,
    });
    const store = new OperationalStateStore(env.STATE);
    const pipeline = await store.getPipeline();
    await store.putPipeline({
      ...pipeline,
      paused: true,
      pauseReason: "authentication",
      pausedAt: "2026-07-25T00:00:00.000Z",
      revision: 1,
    });
  });

  it("refuses account mismatch and leaves the pause in place", async () => {
    await expect(
      resumePipeline(
        env.STATE,
        { getCurrentUser: () => Promise.resolve({ id: 99, fullName: "Other" }) },
        { testConnection: () => Promise.resolve() },
        true,
      ),
    ).resolves.toEqual({ status: "refused", reason: "account_mismatch" });
    expect((await new OperationalStateStore(env.STATE).getPipeline()).paused).toBe(true);
  });

  it("clears a pause only after account and provider validation", async () => {
    await expect(
      resumePipeline(
        env.STATE,
        { getCurrentUser: () => Promise.resolve({ id: 42, fullName: "Owner" }) },
        { testConnection: () => Promise.resolve() },
        true,
      ),
    ).resolves.toEqual({ status: "resumed" });
    expect((await new OperationalStateStore(env.STATE).getPipeline()).paused).toBe(false);
  });
});
