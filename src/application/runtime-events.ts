import { sendPersistentPauseAlert } from "../adapters/cloudflare-email-alerts";
import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { createOrganizer, OrganizerError } from "../adapters/organizer";
import { OperationalStateStore } from "../adapters/operational-state-store";
import { ProviderConfigStore } from "../adapters/provider-config-store";
import { RaindropClient, RaindropHttpError } from "../adapters/raindrop-client";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { parseRuntimeConfig } from "../config";
import { DispatchMessageSchema, type ProviderChoice } from "../domain/schemas";
import { log } from "../observability/logger";
import { clearDispatchLease, dispatchUnsorted } from "./dispatch";
import { organizeBookmark } from "./organize-bookmark";
import { getInstallationSecret } from "../routes/setup-auth";
import { AdminStateStore } from "../adapters/admin-state-store";
import { resyncRegistryIfDue } from "./registry-resync";

export async function handleScheduled(env: Env): Promise<void> {
  const config = parseRuntimeConfig(env);
  const token = await credentialStore(env).get("raindrop");
  if (token === null) {
    log({
      level: "warn",
      event: "cron.discovery_skipped",
      outcome: "raindrop_credential_missing",
    });
    return;
  }
  try {
    const adminStore = new AdminStateStore(env.STATE, config.DISPATCH_LIMIT);
    try {
      await resyncRegistryIfDue(
        env.STATE,
        new RaindropClient(token),
        new Date(),
        adminStore,
      );
    } catch {
      log({
        level: "warn",
        event: "registry.resync_failed",
        outcome: "transient",
      });
    }
    const automation = await adminStore.getAutomation();
    const result = await dispatchUnsorted(
      env.STATE,
      env.ORGANIZE_QUEUE,
      new RaindropClient(token),
      automation.dispatchLimit,
    );
    log({
      level: "info",
      event: "cron.discovery_completed",
      outcome: result.outcome,
    });
  } catch (error) {
    if (
      error instanceof RaindropHttpError &&
      error.status === 429 &&
      error.retryAt !== null
    ) {
      const store = new OperationalStateStore(env.STATE);
      const pipeline = await store.getPipeline();
      await store.putPipeline({
        ...pipeline,
        deferredUntil: error.retryAt,
        deferredReason: "raindrop_rate_limit",
        revision: pipeline.revision + 1,
      });
    }
    log({
      level: "error",
      event: "cron.discovery_failed",
      outcome: "transient",
    });
  }
}

export async function handleQueue(
  batch: MessageBatch,
  env: Env,
): Promise<void> {
  const config = parseRuntimeConfig(env);
  for (const message of batch.messages) {
    const parsed = DispatchMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      log({
        level: "warn",
        event: "queue.message_rejected",
        outcome: "invalid_message",
      });
      message.ack();
      continue;
    }

    const dispatch = await new OperationalStateStore(env.STATE).getDispatch();
    const lease = dispatch.leases[parsed.data.bookmarkId.toString()];
    if (
      lease?.dispatchRevision !== parsed.data.dispatchRevision ||
      new Date(lease.expiresAt) <= new Date()
    ) {
      message.ack();
      continue;
    }

    const onboarding = await new OnboardingStateStore(env.STATE).get();
    if (
      onboarding.status !== "complete" ||
      onboarding.accountUserId !== parsed.data.raindropUserId
    ) {
      await pauseAndAlert(env, "raindrop", "account_guard_failed");
      message.ack();
      continue;
    }

    const token = await credentialStore(env).get("raindrop");
    if (token === null) {
      await pauseAndAlert(env, "raindrop", "missing_credential");
      message.ack();
      continue;
    }

    const providerStore = new ProviderConfigStore(
      env.STATE,
      initialChoice(config),
    );
    const provider = await providerStore.get();
    const providerCredential =
      provider.active.provider === "workers-ai"
        ? null
        : await credentialStore(env).get(provider.active.provider);

    let organizer;
    try {
      organizer = createOrganizer(provider.active, {
        ai: env.AI,
        credential: providerCredential,
      });
    } catch (error) {
      const code =
        error instanceof OrganizerError ? error.code : "provider_configuration";
      await pauseAndAlert(env, provider.active.provider, code);
      message.ack();
      continue;
    }

    const raindrop = new RaindropClient(token);
    const currentUser = await raindrop.getCurrentUser();
    if (currentUser.id !== parsed.data.raindropUserId) {
      await pauseAndAlert(env, "raindrop", "account_guard_failed");
      message.ack();
      continue;
    }

    const outcome = await organizeBookmark(
      env.STATE,
      raindrop,
      organizer,
      provider,
      parsed.data.bookmarkId,
      config.ITEM_MAX_ATTEMPTS,
      config.WORKERS_AI_DAILY_SOFT_LIMIT,
    );
    log({
      level: outcome.outcome === "systemic" ? "error" : "info",
      event: "queue.message_completed",
      bookmarkId: parsed.data.bookmarkId,
      provider: provider.active.provider,
      outcome: outcome.outcome,
    });
    await new AdminStateStore(env.STATE, config.DISPATCH_LIMIT).recordActivity({
      at: new Date().toISOString(),
      event: "bookmark",
      outcome: outcome.outcome,
      bookmarkId: parsed.data.bookmarkId,
    });
    await recordRunSummary(
      env.STATE,
      parsed.data.source,
      parsed.data.enqueuedAt,
      outcome.outcome,
    );

    if (outcome.outcome === "transient") {
      if (
        outcome.retryAt !== undefined &&
        new Date(outcome.retryAt).getTime() - Date.now() > 25 * 60 * 1_000
      ) {
        await clearDispatchLease(env.STATE, parsed.data.bookmarkId);
        message.ack();
      } else {
        message.retry({
          delaySeconds:
            outcome.retryAt === undefined
              ? retryDelay(message.attempts)
              : retryDelayUntil(outcome.retryAt),
        });
      }
    } else {
      if (outcome.outcome === "systemic") {
        const pausedPipeline = await new OperationalStateStore(env.STATE).getPipeline();
        await sendPersistentPauseAlert(env.STATE, env.EMAIL, {
          environment: config.ENVIRONMENT,
          provider: provider.active.provider,
          code: outcome.reason,
          occurredAt: new Date().toISOString(),
          pauseRevision: pausedPipeline.revision,
        });
      }
      message.ack();
    }
  }
}

async function pauseAndAlert(
  env: Env,
  provider: string,
  code: string,
): Promise<void> {
  const store = new OperationalStateStore(env.STATE);
  const pipeline = await store.getPipeline();
  if (pipeline.paused) return;
  const next = {
    ...pipeline,
    paused: true,
    pauseReason: code,
    pausedAt: new Date().toISOString(),
    revision: pipeline.revision + 1,
  };
  await store.putPipeline(next);
  await sendPersistentPauseAlert(env.STATE, env.EMAIL, {
    environment: env.ENVIRONMENT,
    provider,
    code,
    occurredAt: new Date().toISOString(),
    pauseRevision: next.revision,
  });
}

function credentialStore(env: Env): EncryptedCredentialStore {
  return new EncryptedCredentialStore(env.STATE, getInstallationSecret(env));
}

function initialChoice(
  config: ReturnType<typeof parseRuntimeConfig>,
): ProviderChoice {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    promptRevision: 1,
  };
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3_600);
}

function retryDelayUntil(retryAt: string): number {
  return Math.max(1, Math.min(Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1_000), 43_200));
}

async function recordRunSummary(
  namespace: KVNamespace,
  source: "queue" | "backfill",
  startedAt: string,
  outcome: string,
): Promise<void> {
  const store = new OperationalStateStore(namespace);
  const pipeline = await store.getPipeline();
  await store.putPipeline({
    ...pipeline,
    lastRun: {
      runId: crypto.randomUUID(),
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      selected: 1,
      processed: outcome === "processed" || outcome === "duplicate" ? 1 : 0,
      reviewed: outcome === "reviewed" ? 1 : 0,
      deferred: outcome === "transient" || outcome === "deferred_budget" ? 1 : 0,
      failed: outcome === "item_retry" || outcome === "systemic" ? 1 : 0,
    },
    revision: pipeline.revision + 1,
  });
}
