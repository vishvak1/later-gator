import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateOwnerPassword } from "../src/security/owner-auth";

const origin = "https://later-gator.test";

function login(password: string, requestOrigin = origin): Promise<Response> {
  return exports.default.fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("standalone owner login", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM login_attempts"), env.DB.prepare("DELETE FROM sessions")]);
  });

  it("signs in locally and issues secure session and CSRF cookies", async () => {
    const response = await login(env.PASSWORD);
    expect(response.status).toBe(200);
    const cookies = response.headers.get("set-cookie");
    expect(cookies).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookies).toContain("lg_csrf=");
    expect(await response.json()).toMatchObject({ ok: true, redirectTo: "/setup" });
    const row = await env.DB.prepare("SELECT id_hash, csrf_token_hash FROM sessions").first();
    expect(JSON.stringify(row)).not.toContain(env.PASSWORD);
  });

  it("rejects wrong passwords, missing or foreign origins, and oversized input", async () => {
    expect((await login("wrong")).status).toBe(401);
    expect((await login(env.PASSWORD, "https://other.test")).status).toBe(403);
    expect((await login(env.PASSWORD, "")).status).toBe(403);
    expect((await login("x".repeat(5000))).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({ count: 0 });
  });

  it("throttles repeated failures and permits retry after the block expires", async () => {
    for (let i = 0; i < 5; i++) expect((await login("wrong")).status).toBe(401);
    expect((await login(env.PASSWORD)).status).toBe(429);
    await env.DB.prepare("UPDATE login_attempts SET blocked_until = '2000-01-01T00:00:00.000Z'").run();
    expect((await login(env.PASSWORD)).status).toBe(200);
  });

  it("counts concurrent failures atomically", async () => {
    await Promise.all(Array.from({ length: 5 }, () => login("wrong")));
    expect((await login(env.PASSWORD)).status).toBe(429);
  });

  it("fails closed without a configured password and when storage fails", async () => {
    const request = new Request(`${origin}/auth/login`);
    expect(await authenticateOwnerPassword(request, { ...env, PASSWORD: "" }, "anything")).toEqual({ status: "unavailable" });
    const db = { prepare: vi.fn(() => { throw new Error("storage failure"); }) } as unknown as D1Database;
    await expect(authenticateOwnerPassword(request, { ...env, DB: db }, env.PASSWORD)).rejects.toThrow("storage failure");
  });

  it("accepts the browser form and does not expose the old assertion callback", async () => {
    const response = await exports.default.fetch(`${origin}/auth/login`, {
      method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: env.PASSWORD }).toString(),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("lg_session=");
    const callback = await exports.default.fetch(`${origin}/auth/callback?assertion=obsolete&state=obsolete`);
    expect(callback.headers.get("set-cookie") ?? "").not.toContain("Max-Age=1209600");
  });
});
