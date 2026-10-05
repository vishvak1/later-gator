import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/security/sessions";
import { issueCaptureCredential } from "../src/security/capture-credentials";

const origin = "https://later-gator.test";

describe("direct extension connections", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM extension_devices"), env.DB.prepare("DELETE FROM capture_credentials")]);
  });

  it("requires an owner session and CSRF before issuing a connection", async () => {
    const body = JSON.stringify({ kind: "extension", name: "Chrome" });
    expect((await exports.default.fetch(`${origin}/api/capture/credentials`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body,
    })).status).toBe(401);
    const session = await createSession(env.DB);
    const cookie = session.cookie.split(";")[0] ?? "";
    expect((await exports.default.fetch(`${origin}/api/capture/credentials`, {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body,
    })).status).toBe(403);
    const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken };
    const issued = await exports.default.fetch(`${origin}/api/capture/credentials`, { method: "POST", headers, body });
    expect(issued.status).toBe(201);
    const result = await issued.json<{ credential: { id: string; token: string } }>();
    const captureHeaders = { authorization: `Bearer ${result.credential.token}` };
    expect((await exports.default.fetch(`${origin}/api/capture/options`, { headers: captureHeaders })).status).toBe(200);
    const devices = await exports.default.fetch(`${origin}/api/capture/devices`, { headers: { cookie } });
    expect(await devices.json()).toMatchObject({ devices: [{ id: result.credential.id, name: "Chrome" }] });
    expect((await exports.default.fetch(`${origin}/api/capture/devices/${result.credential.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await exports.default.fetch(`${origin}/api/capture/options`, { headers: captureHeaders })).status).toBe(401);
  });

  it("rolls back credential issuance when device registration fails", async () => {
    await env.DB.exec("CREATE TRIGGER fail_device BEFORE INSERT ON extension_devices BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    try {
      await expect(issueCaptureCredential(env.DB, "extension", "Chrome")).rejects.toThrow();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM capture_credentials").first()).toEqual({ count: 0 });
    } finally {
      await env.DB.exec("DROP TRIGGER fail_device;");
    }
  });
});
