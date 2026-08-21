import { z } from "zod";
import {
  contractVersionSchema,
  httpsUrlSchema,
  isoTimestampSchema,
  opaqueIdSchema,
  semverSchema,
} from "./primitives";

export const thumbnailStorageVariantSchema = z.enum(["kv", "r2", "disabled"]);
export const installationStateSchema = z.enum([
  "draft",
  "awaiting_authorization",
  "provisioning",
  "initializing",
  "health_check",
  "ready",
  "retryable_failure",
  "resuming",
  "cleanup_required",
  "cancelled",
]);

export const installationRecordSchema = z
  .object({
    contractVersion: contractVersionSchema,
    installationId: opaqueIdSchema,
    accountId: opaqueIdSchema,
    workerName: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
    workerUrl: httpsUrlSchema,
    storageVariant: thumbnailStorageVariantSchema,
    state: installationStateSchema,
    installedRelease: semverSchema.nullable(),
    desiredRelease: semverSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type InstallationRecord = z.infer<typeof installationRecordSchema>;
