import { z } from "zod";
import {
  consumeExtensionConnectRequest,
  findPairableInstallation,
  storeExtensionConnectRequest,
  storeExtensionPairingGrant,
} from "../adapters/extension-repository";
import type { ControlConfig } from "../domain/config";
import { ControlPlaneError } from "../domain/errors";
import { randomToken, sha256Base64Url } from "../security/encoding";
import {
  issuePairingGrant,
  parseOwnerAssertionKeyRing,
} from "../security/owner-assertions";

const REQUEST_TTL_SECONDS = 600;

const extensionConnectSchema = z.strictObject({
  redirect_uri: z.url().max(2048),
  state: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u),
  device_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  device_name: z.string().trim().min(1).max(100),
});

/** Validates an official or development Chrome identity callback URI. */
function extensionRedirectUri(config: ControlConfig, value: string): string {
  const url = new URL(value);
  const match = /^([a-p]{32})\.chromiumapp\.org$/u.exec(url.hostname);
  if (
    url.protocol !== "https:" ||
    match === null ||
    url.pathname !== "/cloudflare" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ControlPlaneError("extension_redirect_rejected", 400);
  }
  const extensionId = match[1];
  if (
    extensionId === undefined ||
    !config.chromeExtensionIds.includes(extensionId)
  ) {
    throw new ControlPlaneError("extension_redirect_rejected", 403);
  }
  return url.toString();
}

/** Stores a continuation before the browser enters Cloudflare identity login. */
export async function startExtensionPairing(
  database: D1Database,
  config: ControlConfig,
  url: URL,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const parsed = extensionConnectSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new ControlPlaneError("extension_request_rejected", 400);
  const requestToken = randomToken();
  await storeExtensionConnectRequest(database, {
    requestHash: await sha256Base64Url(`extension-request\0${requestToken}`),
    redirectUri: extensionRedirectUri(config, parsed.data.redirect_uri),
    extensionState: parsed.data.state,
    extensionDeviceId: parsed.data.device_id,
    extensionDeviceName: parsed.data.device_name,
    nonce: randomToken(),
    createdAt: nowSeconds,
    expiresAt: nowSeconds + REQUEST_TTL_SECONDS,
  });
  return requestToken;
}

/** Issues a one-time installation-bound grant and redirects only to the extension. */
export async function completeExtensionPairing(
  database: D1Database,
  config: ControlConfig,
  signingKeys: string,
  ownerId: string,
  requestToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(requestToken)) {
    throw new ControlPlaneError("extension_request_rejected", 401);
  }
  const request = await consumeExtensionConnectRequest(
    database,
    await sha256Base64Url(`extension-request\0${requestToken}`),
    nowSeconds,
  );
  if (request === null) throw new ControlPlaneError("extension_request_rejected", 401);
  extensionRedirectUri(config, request.redirectUri);
  const installation = await findPairableInstallation(database, ownerId);
  if (installation === null) {
    const unavailable = new URL(request.redirectUri);
    unavailable.searchParams.set("error", "installation_required");
    unavailable.searchParams.set("device_id", request.extensionDeviceId);
    unavailable.searchParams.set("state", request.extensionState);
    return unavailable.toString();
  }
  const jti = crypto.randomUUID();
  const grant = await issuePairingGrant(
    parseOwnerAssertionKeyRing(signingKeys),
    {
      issuer: config.publicOrigin,
      ownerId,
      installationId: installation.installationId,
      extensionDeviceId: request.extensionDeviceId,
      nonce: request.nonce,
      jti,
    },
    nowSeconds,
  );
  await storeExtensionPairingGrant(database, {
    jtiHash: await sha256Base64Url(`extension-grant\0${jti}`),
    ownerId,
    installationId: installation.installationId,
    extensionDeviceId: request.extensionDeviceId,
    createdAt: nowSeconds,
    expiresAt: nowSeconds + 120,
  });
  const destination = new URL(request.redirectUri);
  destination.searchParams.set("grant", grant);
  destination.searchParams.set("deployment", installation.workerOrigin);
  destination.searchParams.set("device_id", request.extensionDeviceId);
  destination.searchParams.set("device_name", request.extensionDeviceName);
  destination.searchParams.set("state", request.extensionState);
  return destination.toString();
}
