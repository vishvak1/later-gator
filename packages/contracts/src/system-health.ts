import { z } from "zod";
import { contractVersionSchema, semverSchema } from "./primitives";

export const safeHealthErrorCodeSchema = z.enum([
  "binding_unavailable",
  "database_unavailable",
  "migration_required",
  "queue_unavailable",
  "release_incompatible",
]);

export const systemHealthSchema = z
  .object({
    contractVersion: contractVersionSchema,
    runtimeRelease: semverSchema,
    schemaVersion: z.number().int().nonnegative(),
    status: z.enum(["ready", "degraded", "unavailable"]),
    bindingReadiness: z.enum(["ready", "degraded", "unavailable"]),
    queueReadiness: z.enum(["ready", "degraded", "unavailable"]),
    safeErrorCodes: z.array(safeHealthErrorCodeSchema).max(10),
  })
  .strict();

export type SystemHealth = z.infer<typeof systemHealthSchema>;
