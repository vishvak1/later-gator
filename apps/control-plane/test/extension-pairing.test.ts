import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  completeExtensionPairing,
  startExtensionPairing,
} from "../src/application/extension-pairing";
import type { ControlConfig } from "../src/domain/config";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const OWNER_ID = "owner_extension_test";
const INSTALLATION_ID = "installation_extension_test";

const config: ControlConfig = {
  chromeExtensionIds: [EXTENSION_ID],
  environment: "test",
  publicOrigin: "https://latergator.test",
  oidcIssuer: "https://dash.cloudflare.com",
  sessionTtlSeconds: 43_200,
  identityClientId: "test-client",
  identityClientSecret: "test-secret",
  installerTokenEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

/** Builds a valid Chrome identity request with owner-verifiable state and device metadata. */
function connectUrl(overrides: Record<string, string> = {}): URL {
  const url = new URL("https://latergator.test/extension/connect");
  url.search = new URLSearchParams({
    redirect_uri: `https://${EXTENSION_ID}.chromiumapp.org/cloudflare`,
    state: "s".repeat(43),
    device_id: "device_12345678",
    device_name: "Chrome on Mac",
    ...overrides,
  }).toString();
  return url;
}

describe("control-plane extension pairing", () => {
  beforeEach(async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("DELETE FROM extension_pairing_grants"),
      env.CONTROL_DB.prepare("DELETE FROM extension_connect_requests"),
      env.CONTROL_DB.prepare("DELETE FROM installation_runtime_metadata"),
      env.CONTROL_DB.prepare("DELETE FROM provisioning_steps"),
      env.CONTROL_DB.prepare("DELETE FROM installations"),
      env.CONTROL_DB.prepare("DELETE FROM owners"),
      env.CONTROL_DB.prepare(
        "INSERT INTO owners (id, subject_hash, created_at, last_login_at) VALUES (?, ?, 1, 1)",
      ).bind(OWNER_ID, "subject-hash-extension-test"),
      env.CONTROL_DB.prepare(
        `INSERT INTO installations (
           id, owner_id, account_id, storage_mode, requested_plan_json,
           status, current_step, created_at, updated_at
         ) VALUES (?, ?, ?, 'kv', '{}', 'ready', 'health_check', 1, 1)`,
      ).bind(INSTALLATION_ID, OWNER_ID, "a".repeat(32)),
      env.CONTROL_DB.prepare(
        `INSERT INTO installation_runtime_metadata (
           installation_id, worker_origin, current_release, health_status, updated_at
         ) VALUES (?, 'https://personal.example.workers.dev', '1.0.0', 'ready', 1)`,
      ).bind(INSTALLATION_ID),
    ]);
  });

  it("issues one installation-bound redirect and rejects callback replay", async () => {
    const requestToken = await startExtensionPairing(
      env.CONTROL_DB,
      config,
      connectUrl(),
      100,
    );
    const destination = new URL(await completeExtensionPairing(
      env.CONTROL_DB,
      config,
      env.OWNER_ASSERTION_SIGNING_KEYS,
      OWNER_ID,
      requestToken,
      101,
    ));
    expect(destination.origin).toBe(`https://${EXTENSION_ID}.chromiumapp.org`);
    expect(destination.pathname).toBe("/cloudflare");
    expect(destination.searchParams.get("deployment"))
      .toBe("https://personal.example.workers.dev");
    expect(destination.searchParams.get("state")).toBe("s".repeat(43));
    expect(destination.searchParams.get("grant")?.split(".")).toHaveLength(3);
    expect(destination.searchParams.get("device_name")).toBe("Chrome on Mac");
    await expect(completeExtensionPairing(
      env.CONTROL_DB,
      config,
      env.OWNER_ASSERTION_SIGNING_KEYS,
      OWNER_ID,
      requestToken,
      102,
    )).rejects.toMatchObject({ code: "extension_request_rejected" });
  });

  it("rejects an unapproved extension origin in every environment before identity login", async () => {
    for (const environment of ["development", "production", "test"] as const) {
      await expect(startExtensionPairing(
        env.CONTROL_DB,
        { ...config, environment },
        connectUrl({ redirect_uri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/cloudflare" }),
        100,
      )).rejects.toMatchObject({ code: "extension_redirect_rejected" });
    }
  });
});
