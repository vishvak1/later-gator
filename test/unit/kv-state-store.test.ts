import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { KvStateStore, StateValidationError } from "../../src/adapters/kv-state-store";
import { PipelineStateSchema } from "../../src/domain/schemas";

const key = "pipeline:test";

describe("KvStateStore", () => {
  beforeEach(async () => env.STATE.delete(key));

  it("round-trips a validated document", async () => {
    const store = new KvStateStore(env.STATE, key, PipelineStateSchema);
    const state = {
      schemaVersion: 1 as const,
      mode: "scheduled" as const,
      paused: false,
      pauseReason: null,
      pausedAt: null,
      deferredUntil: null,
      deferredReason: null,
      backfillSessionId: null,
      lastRun: null,
      systemicFailureStreak: {
        provider: null,
        distinctBookmarkIds: [],
        code: null,
      },
      revision: 0,
    };
    await store.put(state);
    await expect(store.get()).resolves.toEqual(state);
  });

  it("fails closed on corrupt persisted state", async () => {
    await env.STATE.put(key, JSON.stringify({ schemaVersion: 999 }));
    const store = new KvStateStore(env.STATE, key, PipelineStateSchema);
    await expect(store.get()).rejects.toBeInstanceOf(StateValidationError);
  });
});
