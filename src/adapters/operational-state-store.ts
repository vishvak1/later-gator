import {
  AiUsageStateSchema,
  DispatchStateSchema,
  PipelineStateSchema,
  RegistryStateSchema,
  type AiUsageState,
  type DispatchState,
  type PipelineState,
  type RegistryState,
} from "../domain/schemas";
import { KvStateStore } from "./kv-state-store";

export class OperationalStateStore {
  constructor(private readonly namespace: KVNamespace) {}

  async getPipeline(): Promise<PipelineState> {
    return (
      (await new KvStateStore(
        this.namespace,
        "pipeline:v1",
        PipelineStateSchema,
      ).get()) ?? initialPipelineState()
    );
  }

  async putPipeline(state: PipelineState): Promise<void> {
    await new KvStateStore(
      this.namespace,
      "pipeline:v1",
      PipelineStateSchema,
    ).put(state);
  }

  async getDispatch(): Promise<DispatchState> {
    return (
      (await new KvStateStore(
        this.namespace,
        "dispatch:v1",
        DispatchStateSchema,
      ).get()) ?? initialDispatchState()
    );
  }

  async putDispatch(state: DispatchState): Promise<void> {
    await new KvStateStore(
      this.namespace,
      "dispatch:v1",
      DispatchStateSchema,
    ).put(state);
  }

  async getRegistry(): Promise<RegistryState | null> {
    return new KvStateStore(
      this.namespace,
      "registry:v1",
      RegistryStateSchema,
    ).get();
  }

  async putRegistry(state: RegistryState): Promise<void> {
    await new KvStateStore(
      this.namespace,
      "registry:v1",
      RegistryStateSchema,
    ).put(state);
  }

  async getAiUsage(utcDate: string): Promise<AiUsageState> {
    return (
      (await new KvStateStore(
        this.namespace,
        `ai-usage:${utcDate}`,
        AiUsageStateSchema,
      ).get()) ?? {
        schemaVersion: 1,
        utcDate,
        estimatedNeurons: 0,
        calls: 0,
        lastUpdatedAt: new Date().toISOString(),
      }
    );
  }

  async putAiUsage(state: AiUsageState): Promise<void> {
    await new KvStateStore(
      this.namespace,
      `ai-usage:${state.utcDate}`,
      AiUsageStateSchema,
    ).put(state);
  }
}

export function initialPipelineState(): PipelineState {
  return {
    schemaVersion: 1,
    mode: "scheduled",
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
}

export function initialDispatchState(): DispatchState {
  return {
    schemaVersion: 1,
    leases: {},
    lastDiscoveryAt: null,
    lastDiscovered: 0,
    lastEnqueued: 0,
    revision: 0,
  };
}
