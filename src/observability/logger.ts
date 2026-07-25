import { z } from "zod";

const LogEventSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    event: z.string().regex(/^[a-z0-9_.-]+$/),
    requestId: z.string().optional(),
    runId: z.string().optional(),
    bookmarkId: z.number().int().positive().optional(),
    domain: z.string().optional(),
    provider: z.string().optional(),
    code: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    attempt: z.number().int().positive().optional(),
    outcome: z.string().optional(),
  })
  .strict();

export type LogEvent = z.infer<typeof LogEventSchema>;

export function log(event: LogEvent): void {
  const safeEvent = LogEventSchema.parse(event);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...safeEvent }));
}
