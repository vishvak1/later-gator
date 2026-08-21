import { z } from "zod";
import {
  base64UrlSchema,
  contractVersionSchema,
  httpsUrlSchema,
  opaqueIdSchema,
} from "./primitives";

export const captureScopeSchema = z.enum(["capture:create", "capture:duplicates"]);

export const pairingGrantPayloadSchema = z
  .object({
    contractVersion: contractVersionSchema,
    issuer: httpsUrlSchema,
    audience: opaqueIdSchema,
    subject: z.string().min(1).max(256),
    installationId: opaqueIdSchema,
    extensionDeviceId: opaqueIdSchema,
    requestedScopes: z.array(captureScopeSchema).min(1).max(2),
    nonce: base64UrlSchema,
    jti: opaqueIdSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.expiresAt > value.issuedAt, {
    message: "expiresAt must be later than issuedAt",
    path: ["expiresAt"],
  });

export type PairingGrantPayload = z.infer<typeof pairingGrantPayloadSchema>;
