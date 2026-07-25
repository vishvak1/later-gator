import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { EmailConfigStore } from "../adapters/email-config-store";
import { KvStateStore } from "../adapters/kv-state-store";
import { createOrganizationProvider } from "../adapters/organization-provider";
import { ProviderConfigStore } from "../adapters/provider-config-store";
import { RaindropClient } from "../adapters/raindrop-client";
import { parseRuntimeConfig } from "../config";
import {
  InstallationStateSchema,
  type InstallationState,
  type ProviderChoice,
} from "../domain/schemas";

const INSTALLATION_STATE_KEY = "installation:v1";

export class InstallationValidationError extends Error {
  override readonly name = "InstallationValidationError";
}

export async function validateInstallation(
  env: Env,
  installationSecret: string,
  dependencies: {
    request?: typeof fetch;
    testProvider?: (
      choice: ProviderChoice,
      credential: string | null,
    ) => Promise<void>;
    assertRequiredBindings?: (environment: Env) => void;
  } = {},
): Promise<InstallationState> {
  const config = parseRuntimeConfig(env);
  (dependencies.assertRequiredBindings ?? assertRequiredBindingsPresent)(env);
  await validateKvBinding(env);

  const credentialStore = new EncryptedCredentialStore(env.STATE, installationSecret);
  const raindropToken = await credentialStore.get("raindrop");
  if (raindropToken === null) {
    throw new InstallationValidationError("Raindrop token is missing");
  }

  let raindropUserId: number;
  try {
    const user = await new RaindropClient(raindropToken, dependencies.request).getCurrentUser();
    raindropUserId = user.id;
  } catch {
    throw new InstallationValidationError("Raindrop connection test failed");
  }

  const providerStore = new ProviderConfigStore(env.STATE, initialChoice(config));
  const providerState = await providerStore.get();
  const credential =
    providerState.active.provider === "workers-ai"
      ? null
      : await credentialStore.get(providerState.active.provider);
  try {
    if (dependencies.testProvider !== undefined) {
      await dependencies.testProvider(providerState.active, credential);
    } else {
      const providerDependencies = {
        ai: env.AI,
        credential,
        ...(dependencies.request === undefined ? {} : { request: dependencies.request }),
      };
      await createOrganizationProvider(
        providerState.active,
        providerDependencies,
      ).testConnection();
    }
  } catch {
    throw new InstallationValidationError("Active organization provider test failed");
  }

  const emailState = await new EmailConfigStore(env.STATE).get();
  const state: InstallationState = {
    schemaVersion: 1,
    configurationFingerprint: await configurationFingerprint(config),
    provider: providerState.active.provider,
    model: providerState.active.model,
    raindropUserId,
    bindingsValid: true,
    providerValid: true,
    emailStatus: emailState.status,
    validatedAt: new Date().toISOString(),
  };
  await new KvStateStore(
    env.STATE,
    INSTALLATION_STATE_KEY,
    InstallationStateSchema,
  ).put(state);
  return state;
}

export function assertRequiredBindingsPresent(env: Env): void {
  for (const binding of ["STATE", "AI", "ORGANIZE_QUEUE", "EMAIL"] as const) {
    if (!Reflect.has(env, binding)) {
      throw new InstallationValidationError(`Required binding ${binding} is missing`);
    }
  }
}

async function validateKvBinding(env: Env): Promise<void> {
  const key = `validation:${crypto.randomUUID()}`;
  let written = false;
  try {
    await env.STATE.put(key, "ok", { expirationTtl: 60 });
    written = true;
    if ((await env.STATE.get(key)) !== "ok") {
      throw new InstallationValidationError("KV read-after-write validation failed");
    }
  } finally {
    if (written) await env.STATE.delete(key);
  }
}

async function configurationFingerprint(
  config: ReturnType<typeof parseRuntimeConfig>,
): Promise<string> {
  const input = JSON.stringify({
    bindings: ["AI", "EMAIL", "ORGANIZE_QUEUE", "STATE"],
    environment: config.ENVIRONMENT,
    seedVersion: config.SEED_VERSION,
    dispatchLimit: config.DISPATCH_LIMIT,
    itemMaxAttempts: config.ITEM_MAX_ATTEMPTS,
    workersAiDailySoftLimit: config.WORKERS_AI_DAILY_SOFT_LIMIT,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function initialChoice(config: ReturnType<typeof parseRuntimeConfig>): ProviderChoice {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    promptRevision: 1,
  };
}
