import { z } from "zod";
import {
  buildCloudflareInstallerAuthorizationUrl,
  exchangeCloudflareInstallerCode,
  fetchSingleAuthorizedAccountId,
} from "../adapters/cloudflare-installer";
import { discoverCloudflareIdentity, fetchCloudflareUserId, type Fetcher } from "../adapters/cloudflare-identity";
import {
  consumeInstallerRequest,
  createAuthorizedInstallation,
  findOwnerSubjectHash,
  storeInstallerAuthorization,
  storeInstallerRequest,
  type ThumbnailStorageMode,
} from "../adapters/installation-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { constantTimeEqual, randomToken, sha256Base64Url } from "../security/encoding";
import { encryptInstallerToken } from "../security/installer-token-vault";

const INSTALLER_REQUEST_TTL_SECONDS = 600;

const requestedScopesSchema = z.array(
  z.enum([
    "d1.write",
    "offline_access",
    "user-details.read",
    "vectorize.write",
    "workers-kv-storage.write",
    "workers-r2.write",
    "workers-scripts.write",
  ]),
).min(6).max(7).refine((scopes) => new Set(scopes).size === scopes.length);

const BASE_INSTALLER_SCOPES = [
  "d1.write",
  "offline_access",
  "user-details.read",
  "vectorize.write",
  "workers-kv-storage.write",
  "workers-scripts.write",
] as const;

export interface InstallerRedirect {
  location: string;
  state: string;
}

export interface CompletedInstallerAuthorization {
  accountId: string;
  installationId: string;
  storageMode: ThumbnailStorageMode;
}

/** Returns the exact purpose-specific installer scope set for one storage choice. */
export function installerScopes(storageMode: ThumbnailStorageMode): string[] {
  return [
    ...BASE_INSTALLER_SCOPES,
    ...(storageMode === "r2" ? ["workers-r2.write"] : []),
  ].sort();
}

/** Creates a same-owner installer consent request with an immutable resource plan. */
export async function startInstallerAuthorization(
  database: D1Database,
  config: ControlConfig,
  ownerId: string,
  storageMode: ThumbnailStorageMode,
  fetcher: Fetcher = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<InstallerRedirect> {
  const discovery = await discoverCloudflareIdentity(config, fetcher);
  const state = randomToken();
  const codeVerifier = randomToken(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const scopes = installerScopes(storageMode);
  await storeInstallerRequest(database, {
    stateHash: await sha256Base64Url(state),
    ownerId,
    codeVerifier,
    storageMode,
    requestedScopesJson: JSON.stringify(scopes),
    createdAt: nowSeconds,
    expiresAt: nowSeconds + INSTALLER_REQUEST_TTL_SECONDS,
  });
  return {
    location: buildCloudflareInstallerAuthorizationUrl(
      discovery,
      config,
      state,
      codeChallenge,
      scopes,
    ).toString(),
    state,
  };
}

/** Completes installer consent, encrypts renewable tokens, and creates a resumable plan. */
export async function completeInstallerAuthorization(
  database: D1Database,
  config: ControlConfig,
  input: { code: string; state: string; cookieState: string; ownerId: string },
  fetcher: Fetcher = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CompletedInstallerAuthorization> {
  if (
    !/^[A-Za-z0-9_-]{32,256}$/u.test(input.state) ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(input.cookieState) ||
    !constantTimeEqual(input.state, input.cookieState)
  ) {
    throw new ControlPlaneError("installer_callback_rejected", 401);
  }
  const stored = await consumeInstallerRequest(
    database,
    await sha256Base64Url(input.state),
    input.ownerId,
    nowSeconds,
  );
  if (stored === null) throw new ControlPlaneError("installer_callback_rejected", 401);
  const requestedScopes = requestedScopesSchema.safeParse(
    JSON.parse(stored.requestedScopesJson) as unknown,
  );
  if (!requestedScopes.success) throw new ControlPlaneError("installer_scope_rejected", 403);
  const discovery = await discoverCloudflareIdentity(config, fetcher);
  const token = await exchangeCloudflareInstallerCode(
    discovery,
    config,
    input.code,
    stored.codeVerifier,
    fetcher,
  );
  if (!requestedScopes.data.every((scope) => token.grantedScopes.includes(scope))) {
    throw new ControlPlaneError("installer_scope_rejected", 403);
  }
  const [cloudflareUserId, accountId, expectedSubjectHash] = await Promise.all([
    fetchCloudflareUserId(token.accessToken, fetcher),
    fetchSingleAuthorizedAccountId(token.accessToken, fetcher),
    findOwnerSubjectHash(database, input.ownerId),
  ]);
  if (expectedSubjectHash === null) throw new ControlPlaneError("session_invalid", 403);
  const actualSubjectHash = await sha256Base64Url(`cloudflare-user\u0000${cloudflareUserId}`);
  if (!constantTimeEqual(actualSubjectHash, expectedSubjectHash)) {
    throw new ControlPlaneError("installer_callback_rejected", 403);
  }
  const plan = {
    contractVersion: 1,
    storageMode: stored.storageMode,
    steps: [
      "d1",
      "oauth_kv",
      ...(stored.storageMode === "kv" ? ["thumbnail_kv"] : ["thumbnail_r2"]),
      "vectorize",
      "background_queue",
      "thumbnail_queue",
      "runtime_secret",
      "worker_upload",
      "schema_initialize",
      "queue_consumers",
      "workers_dev",
      "health_check",
    ],
  } as const;
  const installationId = await createAuthorizedInstallation(database, {
    installationId: crypto.randomUUID(),
    ownerId: input.ownerId,
    accountId,
    storageMode: stored.storageMode,
    requestedPlanJson: JSON.stringify(plan),
    nowSeconds,
  });
  const encrypted = await encryptInstallerToken(
    config.installerTokenEncryptionKey,
    input.ownerId,
    accountId,
    token,
    nowSeconds,
  );
  await storeInstallerAuthorization(database, {
    ownerId: input.ownerId,
    accountId,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    grantedScopesJson: JSON.stringify(token.grantedScopes),
    expiresAt: encrypted.expiresAt,
    updatedAt: nowSeconds,
  });
  return { accountId, installationId, storageMode: stored.storageMode };
}
