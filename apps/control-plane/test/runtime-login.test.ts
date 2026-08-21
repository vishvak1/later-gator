import { env, exports } from "cloudflare:workers";
import { ownerAssertionPayloadSchema } from "@later-gator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertOwner } from "../src/adapters/control-repository";
import { decodeBase64UrlText, sha256Base64Url } from "../src/security/encoding";

const INSTALLATION_ID = "d89a58a2-fff3-4566-af96-537f682292a0";
const RUNTIME_ORIGIN = "https://later-gator-d89a58a2fff34566.owner.workers.dev";
const SESSION_TOKEN = "s".repeat(43);

/** Seeds one ready installation and a control-plane session for its exact owner. */
async function readyInstallation(): Promise<void> {
  const ownerId = await upsertOwner(
    env.CONTROL_DB,
    await sha256Base64Url(`runtime-login-owner-${crypto.randomUUID()}`),
    100,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO installations (
         id, owner_id, account_id, storage_mode, requested_plan_json,
         status, current_step, installed_release, desired_release,
         update_status, current_version_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'kv', ?, 'ready', 'health_check', '1.0.0',
                 '1.0.0', 'complete', ?, 100, 100)`,
    ).bind(
      INSTALLATION_ID,
      ownerId,
      "a".repeat(32),
      JSON.stringify({ contractVersion: 1, storageMode: "kv" }),
      "11111111-1111-4111-8111-111111111111",
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO installation_runtime_metadata (
         installation_id, worker_origin, current_release, health_status, updated_at
       ) VALUES (?, ?, '1.0.0', 'ready', 100)`,
    ).bind(INSTALLATION_ID, RUNTIME_ORIGIN),
    env.CONTROL_DB.prepare(
      `INSERT INTO control_sessions (
         session_hash, owner_id, csrf_hash, created_at, expires_at, last_seen_at
       ) VALUES (?, ?, ?, 100, 2000000000, 100)`,
    ).bind(
      await sha256Base64Url(SESSION_TOKEN),
      ownerId,
      await sha256Base64Url("c".repeat(43)),
    ),
  ]);
}

/** Builds the exact runtime-to-control-plane login URL. */
function runtimeLoginUrl(callback = `${RUNTIME_ORIGIN}/auth/callback`): string {
  const url = new URL("https://latergator.test/runtime/login");
  url.searchParams.set("installation_id", INSTALLATION_ID);
  url.searchParams.set("callback", callback);
  url.searchParams.set("nonce", "n".repeat(43));
  url.searchParams.set("state", "r".repeat(43));
  return url.toString();
}

beforeEach(async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM installations"),
    env.CONTROL_DB.prepare("DELETE FROM owners"),
  ]);
  await readyInstallation();
});

describe("personal-runtime owner login", () => {
  it("issues an installation-bound assertion to the exact registered runtime callback", async () => {
    const started = await exports.default.fetch(new Request(runtimeLoginUrl(), {
      headers: { cookie: `lg_cp_session=${SESSION_TOKEN}` },
      redirect: "manual",
    }));
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe("/runtime/login/resume");
    const requestToken = /lg_cp_runtime_login=([^;]+)/u.exec(
      started.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(requestToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const completed = await exports.default.fetch(new Request(
      "https://latergator.test/runtime/login/resume",
      {
        headers: {
          cookie: `lg_cp_session=${SESSION_TOKEN}; lg_cp_runtime_login=${requestToken ?? ""}`,
        },
        redirect: "manual",
      },
    ));
    expect(completed.status).toBe(302);
    const destination = new URL(completed.headers.get("location") ?? "");
    expect(destination.origin + destination.pathname).toBe(`${RUNTIME_ORIGIN}/auth/callback`);
    expect(destination.searchParams.get("state")).toBe("r".repeat(43));
    const assertion = destination.searchParams.get("assertion") ?? "";
    const payload = ownerAssertionPayloadSchema.parse(
      JSON.parse(decodeBase64UrlText(assertion.split(".")[1] ?? "")) as unknown,
    );
    expect(payload).toMatchObject({
      audience: INSTALLATION_ID,
      installationId: INSTALLATION_ID,
      nonce: "n".repeat(43),
    });
    expect(completed.headers.get("set-cookie")).toContain("lg_cp_runtime_login=");
    expect(completed.headers.get("set-cookie")).toContain("Max-Age=0");

    const replayed = await exports.default.fetch(new Request(
      "https://latergator.test/runtime/login/resume",
      {
        headers: {
          cookie: `lg_cp_session=${SESSION_TOKEN}; lg_cp_runtime_login=${requestToken ?? ""}`,
        },
      },
    ));
    expect(replayed.status).toBe(403);
    expect(await replayed.text()).toContain("Reference: session_invalid");
  });

  it("rejects callback substitution before issuing or storing an assertion", async () => {
    const response = await exports.default.fetch(new Request(
      runtimeLoginUrl("https://attacker.example/auth/callback"),
      { headers: { cookie: `lg_cp_session=${SESSION_TOKEN}` } },
    ));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Reference: bad_request");
    expect(await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM runtime_login_requests",
    ).first()).toEqual({ count: 0 });
  });
});
