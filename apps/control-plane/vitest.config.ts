import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Compacts D1 schema statements for the Workers test runtime. */
function compactD1Schema(source: string): string {
  const statements: string[] = [];
  let current: string[] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    current.push(line);
    if (line.endsWith(";")) {
      statements.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) throw new Error("schema.sql contains an incomplete statement");
  return statements.join("\n");
}

const schema = compactD1Schema(readFileSync("./schema.sql", "utf8"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_SCHEMA: schema } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 10_000,
  },
});
