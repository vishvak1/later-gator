import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

declare global {
  // Generated Workers bindings are declared in this global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TEST_SCHEMA: string;
    }
  }
}

beforeAll(async () => {
  await env.DB.exec(env.TEST_SCHEMA);
});
