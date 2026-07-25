import type { OrganizationProvider } from "../adapters/organization-provider";
import { OnboardingStateStore } from "../adapters/onboarding-state-store";
import { OperationalStateStore } from "../adapters/operational-state-store";
import type { RaindropUser } from "../adapters/raindrop-client";

export interface PipelineValidationGateway {
  getCurrentUser(): Promise<RaindropUser>;
}

export async function resumePipeline(
  namespace: KVNamespace,
  raindrop: PipelineValidationGateway,
  provider: OrganizationProvider,
  confirmation: boolean,
): Promise<
  | { status: "resumed" | "already_running" }
  | { status: "refused"; reason: string }
> {
  if (!confirmation) return { status: "refused", reason: "confirmation_required" };
  const onboarding = await new OnboardingStateStore(namespace).get();
  if (onboarding.status !== "complete" || onboarding.accountUserId === null) {
    return { status: "refused", reason: "onboarding_incomplete" };
  }
  const store = new OperationalStateStore(namespace);
  const pipeline = await store.getPipeline();
  if (!pipeline.paused) return { status: "already_running" };
  let user: RaindropUser;
  try {
    user = await raindrop.getCurrentUser();
  } catch {
    return { status: "refused", reason: "raindrop_connection_failed" };
  }
  if (user.id !== onboarding.accountUserId) {
    return { status: "refused", reason: "account_mismatch" };
  }
  try {
    await provider.testConnection();
  } catch {
    return { status: "refused", reason: "provider_validation_failed" };
  }
  await store.putPipeline({
    ...pipeline,
    paused: false,
    pauseReason: null,
    pausedAt: null,
    systemicFailureStreak: {
      provider: null,
      distinctBookmarkIds: [],
      code: null,
    },
    revision: pipeline.revision + 1,
  });
  return { status: "resumed" };
}
