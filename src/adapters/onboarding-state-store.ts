import {
  OnboardingStateSchema,
  RegistryStateSchema,
  type OnboardingState,
  type RegistryState,
} from "../domain/schemas";
import { KvStateStore } from "./kv-state-store";

export class OnboardingStateStore {
  private readonly onboarding: KvStateStore<OnboardingState>;
  private readonly registry: KvStateStore<RegistryState>;

  constructor(namespace: KVNamespace) {
    this.onboarding = new KvStateStore(namespace, "onboarding:v1", OnboardingStateSchema);
    this.registry = new KvStateStore(namespace, "registry:v1", RegistryStateSchema);
  }

  async get(): Promise<OnboardingState> {
    return (await this.onboarding.get()) ?? emptyOnboardingState();
  }

  async put(state: OnboardingState): Promise<void> {
    await this.onboarding.put(state);
  }

  async putRegistry(state: RegistryState): Promise<void> {
    await this.registry.put(state);
  }
}

export function emptyOnboardingState(): OnboardingState {
  return {
    schemaVersion: 1,
    status: "not_started",
    accountUserId: null,
    mode: null,
    currentStep: null,
    startedAt: null,
    completedAt: null,
    cursor: null,
    folderIds: {},
    seedVersion: null,
    revision: 0,
  };
}
