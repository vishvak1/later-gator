import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

describe("Worker HTTP surface", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("credentials:v1"),
      env.STATE.delete("email-config:v1"),
      env.STATE.delete("installation:v1"),
      env.STATE.delete("provider-config:v1"),
      env.STATE.delete("pipeline:v1"),
      env.STATE.delete("dispatch:v1"),
      env.STATE.delete("onboarding:v1"),
      env.STATE.delete("registry:v1"),
      env.STATE.delete("automation-config:v1"),
      env.STATE.delete("maintenance:v1"),
      env.STATE.delete("activity:v1"),
    ]);
  });

  it("returns liveness without state details", async () => {
    const response = await exports.default.fetch("https://example.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the small setup-page enhancement script", async () => {
    const response = await exports.default.fetch("https://example.test/setup.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("navigator.clipboard.writeText");
  });

  it("returns the setup login page without a session", async () => {
    const response = await exports.default.fetch("https://example.test/setup");
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    const html = await response.text();
    expect(html).toContain("Setup password");
    expect(html).toContain('minlength="10"');
  });

  it("keeps cross-origin login submissions blocked", async () => {
    const body = new URLSearchParams({ secret: "local-test-installation-secret" });
    const response = await exports.default.fetch("https://example.test/setup/login", {
      method: "POST",
      body,
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an invalid installation secret", async () => {
    const body = new URLSearchParams({ secret: "incorrect-installation-secret" });
    const response = await exports.default.fetch("https://example.test/setup/login", {
      method: "POST",
      body,
      headers: { origin: "https://example.test" },
      redirect: "manual",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("establishes a hardened setup session for the valid secret", async () => {
    const body = new URLSearchParams({ secret: "local-test-installation-secret" });
    const response = await exports.default.fetch("https://example.test/setup/login", {
      method: "POST",
      body,
      headers: { origin: "https://example.test" },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const authenticated = await exports.default.fetch("https://example.test/setup", {
      headers: { cookie: cookie ?? "" },
    });
    const html = await authenticated.text();
    expect(html).toContain("Let’s organize your Raindrop.");
    expect(html).toContain("Copy connection address");
    expect(/\/mcp\/[a-f0-9]{64}/u.test(html)).toBe(true);
  });

  it("rejects credential changes without a valid session and CSRF token", async () => {
    const response = await exports.default.fetch(
      "https://example.test/admin/credentials/raindrop",
      {
        method: "POST",
        body: new URLSearchParams({
          credential: "raindrop-test-token",
          csrfToken: "invalid",
        }),
        headers: { origin: "https://example.test" },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(401);
  });

  it("stores credentials through setup without exposing their values", async () => {
    const { cookie, csrfToken } = await authenticatedSetup();
    const plaintext = "sk-openai-value-that-must-not-leak";

    const saveResponse = await exports.default.fetch(
      "https://example.test/admin/credentials/provider",
      {
        method: "POST",
        body: new URLSearchParams({
          provider: "openai",
          credential: plaintext,
          csrfToken,
        }),
        headers: {
          cookie,
          origin: "https://example.test",
        },
        redirect: "manual",
      },
    );
    expect(saveResponse.status).toBe(303);

    const persisted = await env.STATE.get("credentials:v1");
    expect(persisted).not.toContain(plaintext);

    const statusResponse = await exports.default.fetch(
      "https://example.test/admin/credentials/status",
      { headers: { cookie } },
    );
    const statusText = await statusResponse.text();
    expect(statusResponse.status).toBe(200);
    expect(statusText).toContain('"openai":{"configured":true');
    expect(statusText).not.toContain(plaintext);

    const page = await exports.default.fetch("https://example.test/setup", {
      headers: { cookie },
    });
    const pageText = await page.text();
    expect(pageText).toContain("OpenAI:");
    expect(pageText).toContain("Configured");
    expect(pageText).not.toContain(plaintext);
  });

  it("requires matching origin and CSRF token for credential changes", async () => {
    const { cookie, csrfToken } = await authenticatedSetup();
    const response = await exports.default.fetch(
      "https://example.test/admin/credentials/raindrop",
      {
        method: "POST",
        body: new URLSearchParams({
          credential: "raindrop-test-token",
          csrfToken,
        }),
        headers: {
          cookie,
          origin: "https://attacker.example",
        },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(403);
    const persisted = await env.STATE.get<{
      raindrop: unknown;
      mcpPath: unknown;
    }>("credentials:v1", "json");
    expect(persisted?.raindrop).toBeNull();
    expect(persisted?.mcpPath).not.toBeNull();
  });

  it("does not activate a provider candidate that has not passed its test", async () => {
    const { cookie, csrfToken } = await authenticatedSetup();
    const response = await exports.default.fetch(
      "https://example.test/admin/provider/activate",
      {
        method: "POST",
        body: new URLSearchParams({ csrfToken }),
        headers: { cookie, origin: "https://example.test" },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(409);

    const statusResponse = await exports.default.fetch(
      "https://example.test/admin/status",
      { headers: { cookie } },
    );
    const status = await statusResponse.json<{
      data: { provider: { active: { provider: string } } };
    }>();
    expect(status.data.provider.active.provider).toBe("workers-ai");
  });

  it("requires explicit acknowledgement before recording email unavailable", async () => {
    const { cookie, csrfToken } = await authenticatedSetup();
    const missingAcknowledgement = await exports.default.fetch(
      "https://example.test/admin/email/unavailable",
      {
        method: "POST",
        body: new URLSearchParams({ csrfToken }),
        headers: { cookie, origin: "https://example.test" },
        redirect: "manual",
      },
    );
    expect(missingAcknowledgement.status).toBe(400);

    const acknowledged = await exports.default.fetch(
      "https://example.test/admin/email/unavailable",
      {
        method: "POST",
        body: new URLSearchParams({
          csrfToken,
          acknowledgement: "alerts_disabled",
        }),
        headers: { cookie, origin: "https://example.test" },
        redirect: "manual",
      },
    );
    expect(acknowledged.status).toBe(303);
    expect(await env.STATE.get("email-config:v1")).toContain('"status":"unavailable"');
  });

  it("keeps the administrative status private", async () => {
    const response = await exports.default.fetch("https://example.test/admin/status");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("returns a bare 401 for an invalid MCP path secret", async () => {
    const response = await exports.default.fetch(
      "https://example.test/mcp/not-the-secret",
      { method: "POST" },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("rotates the MCP path secret through the authenticated settings page", async () => {
    const { cookie, csrfToken } = await authenticatedSetup();
    const originalPage = await exports.default.fetch("https://example.test/setup", {
      headers: { cookie },
    });
    const originalHtml = await originalPage.text();
    const oldSecret = /\/mcp\/([a-f0-9]{64})/u.exec(originalHtml)?.[1];
    expect(oldSecret).toHaveLength(64);

    const rotated = await exports.default.fetch(
      "https://example.test/admin/mcp/rotate",
      {
        method: "POST",
        body: new URLSearchParams({ csrfToken, confirmation: "ROTATE" }),
        headers: { cookie, origin: "https://example.test" },
        redirect: "manual",
      },
    );
    expect(rotated.status).toBe(303);
    const page = await exports.default.fetch("https://example.test/setup", {
      headers: { cookie },
    });
    const html = await page.text();
    const secret = /\/mcp\/([a-f0-9]{64})/u.exec(html)?.[1];
    expect(secret).toHaveLength(64);
    expect(secret).not.toBe(oldSecret);

    const oldResponse = await exports.default.fetch(
      `https://example.test/mcp/${oldSecret ?? ""}`,
      { method: "POST" },
    );
    expect(oldResponse.status).toBe(401);
    const acceptedSecret = await exports.default.fetch(
      `https://example.test/mcp/${secret ?? ""}`,
      { method: "POST" },
    );
    expect(acceptedSecret.status).toBe(503);
  });

  it("stores prompt changes with a new revision and no bookmark processing", async () => {
    const { cookie, csrfToken } = await authenticatedSetup();
    const response = await exports.default.fetch(
      "https://example.test/admin/settings/prompt",
      {
        method: "POST",
        body: new URLSearchParams({
          csrfToken,
          personalInstructions: "Prefer practical engineering tags.",
        }),
        headers: { cookie, origin: "https://example.test" },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(303);
    expect(await env.STATE.get("provider-config:v1")).toContain(
      '"personalInstructions":"Prefer practical engineering tags."',
    );
    await expect(env.STATE.get("dispatch:v1")).resolves.toBeNull();
  });

  it("returns a minimal 404 for unknown routes", async () => {
    const response = await exports.default.fetch("https://example.test/unknown");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});

async function authenticatedSetup(): Promise<{ cookie: string; csrfToken: string }> {
  const loginResponse = await exports.default.fetch("https://example.test/setup/login", {
    method: "POST",
    body: new URLSearchParams({ secret: "local-test-installation-secret" }),
    headers: { origin: "https://example.test" },
    redirect: "manual",
  });
  const cookie = loginResponse.headers.get("set-cookie") ?? "";
  const page = await exports.default.fetch("https://example.test/setup", {
    headers: { cookie },
  });
  const html = await page.text();
  const csrfToken = /name="csrfToken" value="([^"]+)"/u.exec(html)?.[1];
  if (csrfToken === undefined) throw new Error("Setup page did not include a CSRF token");
  return { cookie, csrfToken };
}
