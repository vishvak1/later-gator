import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../../src/config";

const validEnv = {
  ENVIRONMENT: "test",
  LLM_PROVIDER: "workers-ai",
  LLM_MODEL: "test-model",
  SEED_VERSION: "v1",
  DISPATCH_LIMIT: "10",
  ITEM_MAX_ATTEMPTS: "3",
  WORKERS_AI_DAILY_SOFT_LIMIT: "9000",
  TIMEZONE: "Asia/Kolkata",
};

describe("runtime config", () => {
  it("parses numeric variables", () => {
    expect(parseRuntimeConfig(validEnv)).toMatchObject({ DISPATCH_LIMIT: 10, ITEM_MAX_ATTEMPTS: 3 });
  });

  it("rejects unsafe dispatch limits", () => {
    expect(() => parseRuntimeConfig({ ...validEnv, DISPATCH_LIMIT: "0" })).toThrow();
  });
});
