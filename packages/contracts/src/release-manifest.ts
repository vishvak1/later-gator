import { z } from "zod";
import {
  base64UrlSchema,
  contractVersionSchema,
  isoTimestampSchema,
  semverSchema,
  sha256DigestSchema,
} from "./primitives";

export const runtimeBindingSchema = z.enum([
  "ai",
  "browser",
  "d1",
  "images",
  "kv",
  "oauth_kv",
  "queue_background",
  "queue_thumbnail",
  "r2",
  "vectorize",
]);

export const runtimeReleaseManifestSchema = z
  .object({
    contractVersion: contractVersionSchema,
    release: semverSchema,
    publishedAt: isoTimestampSchema,
    compatibilityDate: z.iso.date(),
    artifactDigest: sha256DigestSchema,
    baseSchemaDigest: sha256DigestSchema,
    minimumSchemaVersion: z.number().int().nonnegative(),
    maximumSchemaVersion: z.number().int().nonnegative(),
    requiredBindings: z.array(runtimeBindingSchema).min(1).max(20),
    optionalBindings: z.array(runtimeBindingSchema).max(20),
    healthContractVersion: z.number().int().positive(),
    signingKeyId: z.string().min(1).max(128),
    signature: base64UrlSchema,
  })
  .strict()
  .refine((value) => value.maximumSchemaVersion >= value.minimumSchemaVersion, {
    message: "maximumSchemaVersion must not precede minimumSchemaVersion",
    path: ["maximumSchemaVersion"],
  });

export type RuntimeReleaseManifest = z.infer<typeof runtimeReleaseManifestSchema>;
