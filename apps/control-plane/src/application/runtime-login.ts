import {
  base64UrlSchema,
  opaqueIdSchema,
} from "@later-gator/contracts";
import { z } from "zod";
import {
  consumeRuntimeLoginRequest,
  findRuntimeLoginTarget,
  storeRuntimeLoginRequest,
} from "../adapters/installation-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { randomToken, sha256Base64Url } from "../security/encoding";
import {
  issueOwnerAssertion,
  parseOwnerAssertionKeyRing,
} from "../security/owner-assertions";

const RUNTIME_LOGIN_TTL_SECONDS = 600;
const runtimeLoginQuerySchema = z.object({
  callback: z.url(),
  installationId: opaqueIdSchema,
  nonce: base64UrlSchema,
  state: base64UrlSchema,
}).strict();

export interface StartedRuntimeLogin {
  ownerId: string;
  requestToken: string;
}

/** Validates and stores one personal-runtime login request before owner authentication. */
export async function startRuntimeLogin(
  database: D1Database,
  url: URL,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<StartedRuntimeLogin> {
  const allowedParameters = ["callback", "installation_id", "nonce", "state"];
  if (
    [...url.searchParams.keys()].some((key) => !allowedParameters.includes(key)) ||
    allowedParameters.some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    throw new ControlPlaneError("bad_request", 400);
  }
  const parsed = runtimeLoginQuerySchema.safeParse({
    callback: url.searchParams.get("callback"),
    installationId: url.searchParams.get("installation_id"),
    nonce: url.searchParams.get("nonce"),
    state: url.searchParams.get("state"),
  });
  if (!parsed.success) throw new ControlPlaneError("bad_request", 400);
  const target = await findRuntimeLoginTarget(database, parsed.data.installationId);
  if (target === null) throw new ControlPlaneError("not_found", 404);
  const callback = new URL(parsed.data.callback);
  if (
    callback.origin !== target.workerOrigin ||
    callback.pathname !== "/auth/callback" ||
    callback.search !== "" ||
    callback.hash !== "" ||
    callback.username !== "" ||
    callback.password !== ""
  ) {
    throw new ControlPlaneError("bad_request", 400);
  }
  const requestToken = randomToken();
  await storeRuntimeLoginRequest(database, {
    requestHash: await sha256Base64Url(requestToken),
    ownerId: target.ownerId,
    installationId: parsed.data.installationId,
    callbackUrl: callback.toString(),
    nonce: parsed.data.nonce,
    runtimeState: parsed.data.state,
    createdAt: nowSeconds,
    expiresAt: nowSeconds + RUNTIME_LOGIN_TTL_SECONDS,
  });
  return { ownerId: target.ownerId, requestToken };
}

/** Issues one installation-bound assertion and returns its exact runtime callback. */
export async function completeRuntimeLogin(
  database: D1Database,
  config: ControlConfig,
  signingKeysJson: string,
  ownerId: string,
  requestToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(requestToken)) {
    throw new ControlPlaneError("session_invalid", 403);
  }
  const pending = await consumeRuntimeLoginRequest(
    database,
    await sha256Base64Url(requestToken),
    ownerId,
    nowSeconds,
  );
  if (pending === null) throw new ControlPlaneError("session_invalid", 403);
  const assertion = await issueOwnerAssertion(
    parseOwnerAssertionKeyRing(signingKeysJson),
    {
      issuer: config.publicOrigin,
      ownerId,
      installationId: pending.installationId,
      nonce: pending.nonce,
    },
    nowSeconds,
  );
  const destination = new URL(pending.callbackUrl);
  destination.searchParams.set("assertion", assertion);
  destination.searchParams.set("state", pending.runtimeState);
  return destination.toString();
}
