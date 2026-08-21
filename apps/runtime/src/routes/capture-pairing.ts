import { pairingGrantPayloadSchema } from "@later-gator/contracts";
import { z } from "zod";
import { readRuntimeIdentityConfig } from "../domain/runtime-config";
import {
  issuePairedExtensionCredential,
} from "../security/capture-credentials";
import { sha256Base64 } from "../security/encoding";
import {
  OwnerLoginError,
  verifyControlPlaneSignedPayload,
} from "../security/owner-auth";
import { apiError, json, readJson } from "./responses";
import { cors } from "./capture";

const pairingExchangeSchema = z.strictObject({
  grant: z.string().min(32).max(8192),
  deviceId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  deviceName: z.string().trim().min(1).max(100),
});

/** Exchanges a signed one-time pairing grant for the existing narrow capture token. */
export async function capturePairingExchange(request: Request, env: Env): Promise<Response> {
  let parsed;
  try {
    parsed = pairingExchangeSchema.safeParse(await readJson(request, 16 * 1024));
  } catch {
    return cors(apiError(400, "pairing_invalid", "Restart the Cloudflare connection."));
  }
  if (!parsed.success) {
    return cors(apiError(400, "pairing_invalid", "Restart the Cloudflare connection."));
  }
  try {
    const [grant, config, owner] = await Promise.all([
      verifyControlPlaneSignedPayload(
        parsed.data.grant,
        env,
        "LG-PAIRING",
        pairingGrantPayloadSchema,
      ),
      Promise.resolve(readRuntimeIdentityConfig(env)),
      env.DB.prepare("SELECT subject FROM owner_identity WHERE id = 1")
        .first<{ subject: string }>(),
    ]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      grant.audience !== config.installationId ||
      grant.installationId !== config.installationId ||
      grant.extensionDeviceId !== parsed.data.deviceId ||
      owner?.subject !== grant.subject ||
      grant.expiresAt <= nowSeconds ||
      grant.issuedAt > nowSeconds + 30 ||
      !grant.requestedScopes.includes("capture:create")
    ) {
      return cors(apiError(403, "pairing_wrong_owner", "This connection belongs to another installation."));
    }
    const credential = await issuePairedExtensionCredential(env.DB, {
      deviceId: parsed.data.deviceId,
      deviceName: parsed.data.deviceName,
      jtiHash: await sha256Base64(`extension-pairing-jti:${grant.jti}`),
    });
    return cors(json({ ok: true, credential }, { status: 201 }));
  } catch (error: unknown) {
    const code = error instanceof Error && error.message === "pairing_grant_replayed"
      ? "pairing_replayed"
      : error instanceof OwnerLoginError && error.safeCode === "assertion_expired"
        ? "pairing_expired"
        : "pairing_invalid";
    return cors(apiError(401, code, "Restart the Cloudflare connection."));
  }
}
