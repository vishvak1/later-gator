import { z } from "zod";
import {
  base64UrlSchema,
  contractVersionSchema,
  httpsUrlSchema,
  opaqueIdSchema,
} from "./primitives";

export const ownerAssertionPayloadSchema = z
  .object({
    contractVersion: contractVersionSchema,
    issuer: httpsUrlSchema,
    audience: opaqueIdSchema,
    subject: z.string().min(1).max(256),
    installationId: opaqueIdSchema,
    nonce: base64UrlSchema,
    jti: opaqueIdSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.expiresAt > value.issuedAt, {
    message: "expiresAt must be later than issuedAt",
    path: ["expiresAt"],
  })
  .refine((value) => value.expiresAt - value.issuedAt <= 300, {
    message: "owner assertions may live for at most five minutes",
    path: ["expiresAt"],
  })
  .refine((value) => value.audience === value.installationId, {
    message: "audience must identify the bound installation",
    path: ["audience"],
  });

export type OwnerAssertionPayload = z.infer<typeof ownerAssertionPayloadSchema>;
