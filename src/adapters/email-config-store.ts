import {
  EmailConfigStateSchema,
  type EmailConfigState,
} from "../domain/schemas";
import { KvStateStore } from "./kv-state-store";

const STATE_KEY = "email-config:v1";

export class EmailConfigStore {
  private readonly stateStore: KvStateStore<EmailConfigState>;

  constructor(namespace: KVNamespace) {
    this.stateStore = new KvStateStore(namespace, STATE_KEY, EmailConfigStateSchema);
  }

  async get(): Promise<EmailConfigState> {
    return (await this.stateStore.get()) ?? createInitialState();
  }

  async recordTest(
    input: {
      recipient: string;
      from: string;
      status: EmailConfigState["status"];
      deliveryCode: string | null;
    },
    now = new Date().toISOString(),
  ): Promise<EmailConfigState> {
    const current = await this.get();
    const next: EmailConfigState = {
      ...current,
      recipient: input.recipient,
      from: input.from,
      status: input.status,
      testSentAt: input.status === "ready" ? now : null,
      lastDeliveryAt: input.status === "ready" ? now : null,
      lastDeliveryCode: input.deliveryCode,
      revision: current.revision + 1,
    };
    await this.stateStore.put(next);
    return next;
  }

  async markUnavailable(): Promise<EmailConfigState> {
    const current = await this.get();
    const next: EmailConfigState = {
      ...current,
      status: "unavailable",
      revision: current.revision + 1,
    };
    await this.stateStore.put(next);
    return next;
  }

  async recordDelivery(
    code: string,
    delivered: boolean,
    now = new Date().toISOString(),
    pauseRevision?: number,
  ): Promise<EmailConfigState> {
    const current = await this.get();
    const next: EmailConfigState = {
      ...current,
      lastDeliveryAt: delivered ? now : current.lastDeliveryAt,
      lastDeliveryCode: code.slice(0, 100),
      lastAlertPauseRevision: pauseRevision ?? current.lastAlertPauseRevision,
      revision: current.revision + 1,
    };
    await this.stateStore.put(next);
    return next;
  }
}

function createInitialState(): EmailConfigState {
  return {
    schemaVersion: 1,
    recipient: null,
    from: null,
    status: "needs_domain",
    testSentAt: null,
    lastDeliveryAt: null,
    lastDeliveryCode: null,
    lastAlertPauseRevision: null,
    revision: 0,
  };
}
