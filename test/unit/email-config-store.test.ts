import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailConfigStore } from "../../src/adapters/email-config-store";

describe("EmailConfigStore", () => {
  beforeEach(async () => env.STATE.delete("email-config:v1"));

  it("starts in the honest needs-domain state", async () => {
    await expect(new EmailConfigStore(env.STATE).get()).resolves.toMatchObject({
      status: "needs_domain",
      recipient: null,
      from: null,
    });
  });

  it("records readiness only after a successful test result", async () => {
    const store = new EmailConfigStore(env.STATE);
    const state = await store.recordTest(
      {
        recipient: "owner@example.test",
        from: "alerts@example.test",
        status: "ready",
        deliveryCode: "sent",
      },
      "2026-07-25T00:00:00.000Z",
    );
    expect(state.status).toBe("ready");
    expect(state.testSentAt).toBe("2026-07-25T00:00:00.000Z");
  });

  it("requires an explicit state transition to continue without alerts", async () => {
    const state = await new EmailConfigStore(env.STATE).markUnavailable();
    expect(state.status).toBe("unavailable");
    expect(state.revision).toBe(1);
  });
});
