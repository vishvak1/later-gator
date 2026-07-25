import {
  ProviderChoiceSchema,
  ProviderConfigStateSchema,
  type ProviderChoice,
  type ProviderConfigState,
} from "../domain/schemas";
import { KvStateStore } from "./kv-state-store";

const STATE_KEY = "provider-config:v1";

export class ProviderActivationError extends Error {
  override readonly name = "ProviderActivationError";
}

export class ProviderConfigStore {
  private readonly stateStore: KvStateStore<ProviderConfigState>;

  constructor(
    namespace: KVNamespace,
    private readonly initialChoice: ProviderChoice,
  ) {
    this.stateStore = new KvStateStore(namespace, STATE_KEY, ProviderConfigStateSchema);
  }

  async get(): Promise<ProviderConfigState> {
    return (await this.stateStore.get()) ?? createInitialState(this.initialChoice);
  }

  async recordCandidateTest(
    choiceInput: ProviderChoice,
    succeeded: boolean,
    testedAt = new Date().toISOString(),
  ): Promise<ProviderConfigState> {
    const choice = ProviderChoiceSchema.parse(choiceInput);
    const current = await this.get();
    const next: ProviderConfigState = {
      ...current,
      candidate: choice,
      candidateTestedAt: testedAt,
      candidateTestSucceeded: succeeded,
      revision: current.revision + 1,
    };
    await this.stateStore.put(next);
    return next;
  }

  async activateTestedCandidate(): Promise<ProviderConfigState> {
    const current = await this.get();
    if (current.candidate === null || !current.candidateTestSucceeded) {
      throw new ProviderActivationError("A successful candidate test is required");
    }

    const next: ProviderConfigState = {
      ...current,
      active: current.candidate,
      candidate: null,
      candidateTestedAt: null,
      candidateTestSucceeded: false,
      revision: current.revision + 1,
    };
    await this.stateStore.put(next);
    return next;
  }

  async updatePrompt(input: {
    personalInstructions: string;
    fullPromptOverride: string | null;
  }): Promise<ProviderConfigState> {
    const current = await this.get();
    const next: ProviderConfigState = ProviderConfigStateSchema.parse({
      ...current,
      active: {
        ...current.active,
        promptRevision: current.active.promptRevision + 1,
      },
      personalInstructions: input.personalInstructions,
      fullPromptOverride: input.fullPromptOverride,
      revision: current.revision + 1,
    });
    await this.stateStore.put(next);
    return next;
  }

  async restoreDefaultPrompt(): Promise<ProviderConfigState> {
    return this.updatePrompt({
      personalInstructions: "",
      fullPromptOverride: null,
    });
  }
}

function createInitialState(initialChoiceInput: ProviderChoice): ProviderConfigState {
  const initialChoice = ProviderChoiceSchema.parse(initialChoiceInput);
  return {
    schemaVersion: 1,
    active: initialChoice,
    candidate: null,
    candidateTestedAt: null,
    candidateTestSucceeded: false,
    personalInstructions: "",
    fullPromptOverride: null,
    revision: 0,
  };
}
