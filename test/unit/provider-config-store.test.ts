import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ProviderActivationError,
  ProviderConfigStore,
} from "../../src/adapters/provider-config-store";

const initialChoice = {
  provider: "workers-ai" as const,
  model: "default-model",
  promptRevision: 1,
};

describe("ProviderConfigStore", () => {
  beforeEach(async () => env.STATE.delete("provider-config:v1"));

  it("keeps the active provider unchanged when a candidate test fails", async () => {
    const store = new ProviderConfigStore(env.STATE, initialChoice);
    const candidate = {
      provider: "openai" as const,
      model: "candidate-model",
      promptRevision: 1,
    };

    const tested = await store.recordCandidateTest(candidate, false, "2026-07-25T00:00:00.000Z");
    expect(tested.active).toEqual(initialChoice);
    expect(tested.candidate).toEqual(candidate);
    await expect(store.activateTestedCandidate()).rejects.toBeInstanceOf(
      ProviderActivationError,
    );
    await expect(store.get()).resolves.toMatchObject({ active: initialChoice });
  });

  it("activates only a successfully tested candidate", async () => {
    const store = new ProviderConfigStore(env.STATE, initialChoice);
    const candidate = {
      provider: "anthropic" as const,
      model: "candidate-model",
      promptRevision: 1,
    };

    await store.recordCandidateTest(candidate, true, "2026-07-25T00:00:00.000Z");
    const activated = await store.activateTestedCandidate();
    expect(activated.active).toEqual(candidate);
    expect(activated.candidate).toBeNull();
    expect(activated.candidateTestSucceeded).toBe(false);
  });
});
