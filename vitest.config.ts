import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // BOOTSTRAP_PASSWORD is pinned so a developer's .dev.vars cannot leak
        // into the test environment.
        bindings: { TEST_MIGRATIONS: migrations, BOOTSTRAP_PASSWORD: "test-pass" },
      },
    }),
  ],
  test: {
    include: ["test/v6/**/*.test.ts"],
    setupFiles: ["./test/v6/setup.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
