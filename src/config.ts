import { z } from "zod";

const RuntimeConfigSchema = z.object({
  ENVIRONMENT: z.enum(["development", "test", "production"]),
  LLM_PROVIDER: z.enum(["workers-ai", "anthropic", "openai"]),
  LLM_MODEL: z.string().trim().min(1).max(200),
  SEED_VERSION: z.string().trim().min(1).max(50),
  DISPATCH_LIMIT: z.coerce.number().int().min(1).max(50),
  ITEM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10),
  WORKERS_AI_DAILY_SOFT_LIMIT: z.coerce.number().int().positive(),
  TIMEZONE: z.string().min(1).max(100).refine(isTimezone, "Invalid IANA timezone"),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function parseRuntimeConfig(env: unknown): RuntimeConfig {
  return RuntimeConfigSchema.parse(env);
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
