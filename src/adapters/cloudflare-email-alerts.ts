import { EmailConfigStore } from "./email-config-store";

export async function sendPersistentPauseAlert(
  namespace: KVNamespace,
  email: SendEmail,
  input: {
    environment: string;
    provider: string;
    code: string;
    occurredAt: string;
    pauseRevision: number;
  },
): Promise<void> {
  const store = new EmailConfigStore(namespace);
  const config = await store.get();
  if (
    config.status !== "ready" ||
    config.recipient === null ||
    config.from === null
  ) {
    return;
  }
  if (config.lastAlertPauseRevision === input.pauseRevision) return;

  try {
    await email.send({
      to: config.recipient,
      from: { email: config.from, name: "Later Gator" },
      subject: "Later Gator needs attention",
      text: [
        "Later Gator paused because it needs your intervention.",
        `Environment: ${input.environment}`,
        `Provider: ${input.provider}`,
        `Code: ${input.code}`,
        `Time: ${input.occurredAt}`,
        "Open the authenticated Later Gator setup page to review and resume.",
      ].join("\n"),
      html: `<p>Later Gator paused because it needs your intervention.</p><ul><li>Environment: ${escapeHtml(input.environment)}</li><li>Provider: ${escapeHtml(input.provider)}</li><li>Code: ${escapeHtml(input.code)}</li><li>Time: ${escapeHtml(input.occurredAt)}</li></ul><p>Open the authenticated Later Gator setup page to review and resume.</p>`,
    });
    await store.recordDelivery(
      "pause_alert_sent",
      true,
      input.occurredAt,
      input.pauseRevision,
    );
  } catch (error) {
    await store.recordDelivery(
      getErrorCode(error) ?? "pause_alert_failed",
      false,
      undefined,
      input.pauseRevision,
    );
  }
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code.slice(0, 100) : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
