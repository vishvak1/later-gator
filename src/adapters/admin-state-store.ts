import {
  ActivityStateSchema,
  AutomationConfigStateSchema,
  MaintenanceStateSchema,
  type ActivityEntry,
  type ActivityState,
  type AutomationConfigState,
  type MaintenanceState,
} from "../domain/schemas";
import { KvStateStore } from "./kv-state-store";

export class AdminStateStore {
  constructor(
    private readonly namespace: KVNamespace,
    private readonly defaultDispatchLimit: number,
  ) {}

  async getAutomation(): Promise<AutomationConfigState> {
    return (
      (await new KvStateStore(
        this.namespace,
        "automation-config:v1",
        AutomationConfigStateSchema,
      ).get()) ?? {
        schemaVersion: 1,
        dispatchLimit: this.defaultDispatchLimit,
        revision: 0,
      }
    );
  }

  async putAutomation(state: AutomationConfigState): Promise<void> {
    await new KvStateStore(
      this.namespace,
      "automation-config:v1",
      AutomationConfigStateSchema,
    ).put(state);
  }

  async getMaintenance(): Promise<MaintenanceState> {
    return (
      (await new KvStateStore(
        this.namespace,
        "maintenance:v1",
        MaintenanceStateSchema,
      ).get()) ?? {
        schemaVersion: 1,
        lastRegistryResyncAt: null,
        revision: 0,
      }
    );
  }

  async putMaintenance(state: MaintenanceState): Promise<void> {
    await new KvStateStore(
      this.namespace,
      "maintenance:v1",
      MaintenanceStateSchema,
    ).put(state);
  }

  async getActivity(): Promise<ActivityState> {
    return (
      (await new KvStateStore(
        this.namespace,
        "activity:v1",
        ActivityStateSchema,
      ).get()) ?? { schemaVersion: 1, entries: [], revision: 0 }
    );
  }

  async recordActivity(entry: ActivityEntry): Promise<void> {
    const current = await this.getActivity();
    await new KvStateStore(
      this.namespace,
      "activity:v1",
      ActivityStateSchema,
    ).put({
      ...current,
      entries: [entry, ...current.entries].slice(0, 50),
      revision: current.revision + 1,
    });
  }
}
