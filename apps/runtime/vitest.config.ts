import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Converts each schema statement to one line, as required by D1Database.exec. */
function compactD1Schema(source: string): string {
  const statements: string[] = [];
  let current: string[] = [];
  let trigger = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (current.length === 0) trigger = line.startsWith("CREATE TRIGGER");
    current.push(line);
    if ((!trigger && line.endsWith(";")) || (trigger && line === "END;")) {
      statements.push(current.join(" "));
      current = [];
      trigger = false;
    }
  }
  if (current.length > 0) throw new Error("schema.sql contains an incomplete statement");
  return statements.join("\n");
}

const schema = compactD1Schema(readFileSync("./schema.sql", "utf8"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Workers AI has no local simulator. Production code receives explicit
      // fake Env objects in tests, so CI must never open a remote binding proxy.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // Test bindings are pinned so a developer's .dev.vars cannot leak into
        // the test environment.
        bindings: {
          TEST_SCHEMA: schema,
          INSTANCE_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
