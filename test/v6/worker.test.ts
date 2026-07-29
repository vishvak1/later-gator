import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

interface AuthenticatedClient {
  cookie: string;
  csrf: string;
}

async function login(): Promise<AuthenticatedClient> {
  const response = await exports.default.fetch("https://later-gator.test/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "local-test-later-gator-password" }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<{ csrfToken: string }>();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { cookie, csrf: body.csrfToken };
}

function mutationHeaders(client: AuthenticatedClient): HeadersInit {
  return {
    cookie: client.cookie,
    origin: "https://later-gator.test",
    "content-type": "application/json",
    "x-csrf-token": client.csrf,
  };
}

async function finishSetup(client: AuthenticatedClient): Promise<void> {
  const response = await exports.default.fetch("https://later-gator.test/api/setup/complete", {
    method: "POST",
    headers: mutationHeaders(client),
    body: JSON.stringify({
      relevantTags: ["ai", "systems", "design", "research", "typescript"],
      careerContext: "Software engineer",
      aspirationContext: "Build useful AI systems",
      personalInstructions: null,
      timezone: "Asia/Kolkata",
    }),
  });
  expect(response.status).toBe(200);
}

describe("v6 Worker foundation", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("serves an unauthenticated login page at the root", async () => {
    const response = await exports.default.fetch("https://later-gator.test/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Later Gator password");
  });

  it("initializes authentication and redirects an unfinished account to setup", async () => {
    const client = await login();
    const authConfig = await env.DB
      .prepare("SELECT kdf_iterations FROM auth_config WHERE id = 1")
      .first<{ kdf_iterations: number }>();
    expect(authConfig).toEqual({ kdf_iterations: 100_000 });
    const response = await exports.default.fetch("https://later-gator.test/", {
      headers: { cookie: client.cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://later-gator.test/setup");
  });

  it("returns a controlled error for an unsupported stored KDF configuration", async () => {
    await login();
    await env.DB
      .prepare("UPDATE auth_config SET kdf_iterations = 100001 WHERE id = 1")
      .run();
    try {
      const response = await exports.default.fetch(
        "https://later-gator.test/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "local-test-later-gator-password" }),
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "authentication_unavailable" },
      });
    } finally {
      await env.DB
        .prepare("UPDATE auth_config SET kdf_iterations = 100000 WHERE id = 1")
        .run();
    }
  });

  it("requires CSRF on setup mutations", async () => {
    const client = await login();
    const response = await exports.default.fetch("https://later-gator.test/api/setup/complete", {
      method: "POST",
      headers: {
        cookie: client.cookie,
        origin: "https://later-gator.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it("creates a bookmark once and supports a date-added range", async () => {
    const client = await login();
    await finishSetup(client);
    const createResponse = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://Example.com/article#reading",
        title: "Example article",
        organizationPolicy: "none",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      bookmark: { id: string; revision: number };
    }>();

    const duplicateResponse = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://example.com/article",
        organizationPolicy: "none",
      }),
    });
    expect(duplicateResponse.status).toBe(200);

    const listResponse = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks?dateField=added_at&dateFrom=${encodeURIComponent(
        "2020-01-01T00:00:00.000Z",
      )}&dateTo=${encodeURIComponent("2099-01-01T00:00:00.000Z")}`,
      { headers: { cookie: client.cookie } },
    );
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json<{ bookmarks: { id: string }[] }>();
    expect(listed.bookmarks.map((bookmark) => bookmark.id)).toContain(created.bookmark.id);
  });

  it("protects edits with the bookmark revision", async () => {
    const client = await login();
    await finishSetup(client);
    const createResponse = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://example.org/revision-test",
        organizationPolicy: "none",
      }),
    });
    const created = await createResponse.json<{ bookmark: { id: string } }>();

    const response = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}`,
      {
        method: "PATCH",
        headers: mutationHeaders(client),
        body: JSON.stringify({ expectedRevision: 999, title: "Stale edit" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json<{ error: { code: string } }>()).toMatchObject({
      error: { code: "bookmark_changed" },
    });
  });

  it("replaces bookmark tags and retires a tag globally without deleting bookmarks", async () => {
    const client = await login();
    await finishSetup(client);
    const createResponse = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://example.net/tag-test",
        tags: ["testing"],
        organizationPolicy: "none",
      }),
    });
    const created = await createResponse.json<{
      bookmark: { id: string; revision: number };
    }>();
    const bootstrapResponse = await exports.default.fetch(
      "https://later-gator.test/api/bootstrap",
      { headers: { cookie: client.cookie } },
    );
    const bootstrap = await bootstrapResponse.json<{
      state: { tags: { id: string; normalized_name: string }[] };
    }>();
    const testingTag = bootstrap.state.tags.find((tag) => tag.normalized_name === "testing");
    expect(testingTag).toBeDefined();

    const editResponse = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}`,
      {
        method: "PATCH",
        headers: mutationHeaders(client),
        body: JSON.stringify({
          expectedRevision: created.bookmark.revision,
          tags: ["testing", "quality"],
        }),
      },
    );
    expect(editResponse.status, await editResponse.clone().text()).toBe(200);

    const retireResponse = await exports.default.fetch(
      `https://later-gator.test/api/tags/${testingTag?.id ?? ""}`,
      {
        method: "DELETE",
        headers: mutationHeaders(client),
      },
    );
    expect(retireResponse.status).toBe(200);
    expect(await retireResponse.json()).toMatchObject({ affectedBookmarks: 1 });

    const bookmarkResponse = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}`,
      { headers: { cookie: client.cookie } },
    );
    expect(bookmarkResponse.status).toBe(200);
  });

  it("enters and exits edit mode without a scheduled trigger", async () => {
    const client = await login();
    await finishSetup(client);
    const enterResponse = await exports.default.fetch(
      "https://later-gator.test/api/edit-mode",
      {
        method: "PUT",
        headers: mutationHeaders(client),
        body: JSON.stringify({ active: true }),
      },
    );
    expect(enterResponse.status).toBe(200);

    const activeState = await exports.default.fetch("https://later-gator.test/api/bootstrap", {
      headers: { cookie: client.cookie },
    });
    expect(await activeState.json()).toMatchObject({ state: { editMode: "active" } });

    const exitResponse = await exports.default.fetch(
      "https://later-gator.test/api/edit-mode",
      {
        method: "PUT",
        headers: mutationHeaders(client),
        body: JSON.stringify({ active: false }),
      },
    );
    expect(exitResponse.status).toBe(200);
  });

  it("does not claim a local estimate is account-wide Workers AI usage", async () => {
    const client = await login();
    const response = await exports.default.fetch("https://later-gator.test/api/usage", {
      headers: { cookie: client.cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: "account-wide",
      source: "cloudflare-dashboard",
      recordedByLaterGator: false,
    });
  });

  it("supports scoped iOS capture, strict minimal input, and idempotent replay", async () => {
    const client = await login();
    await finishSetup(client);
    await exports.default.fetch("https://later-gator.test/api/automation/pause", {
      method: "PUT",
      headers: mutationHeaders(client),
      body: JSON.stringify({ paused: true, reason: "test" }),
    });
    const credentialResponse = await exports.default.fetch(
      "https://later-gator.test/api/capture/credentials",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ kind: "ios", name: "Test shortcut" }),
      },
    );
    expect(credentialResponse.status).toBe(201);
    const credential = await credentialResponse.json<{
      credential: { token: string };
    }>();
    const requestId = crypto.randomUUID();
    const invalid = await exports.default.fetch("https://later-gator.test/api/capture/ios", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId,
        url: "https://example.com/ios-strict",
        note: "iOS is intentionally URL-only",
      }),
    });
    expect(invalid.status).toBe(400);

    const body = JSON.stringify({ requestId, url: "https://example.com/ios-strict" });
    const first = await exports.default.fetch("https://later-gator.test/api/capture/ios", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.credential.token}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(first.status).toBe(201);
    expect(await first.clone().json()).toMatchObject({ ok: true, result: "saved" });
    const replay = await exports.default.fetch("https://later-gator.test/api/capture/ios", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.credential.token}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(await first.text());

    const conflict = await exports.default.fetch("https://later-gator.test/api/capture/ios", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId, url: "https://example.com/different" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("previews and commits the actual Raindrop CSV shape in bounded chunks", async () => {
    const client = await login();
    await finishSetup(client);
    await exports.default.fetch("https://later-gator.test/api/automation/pause", {
      method: "PUT",
      headers: mutationHeaders(client),
      body: JSON.stringify({ paused: true, reason: "test import" }),
    });
    const csv = [
      "id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite",
      'r-1,"CSV title","A note","An excerpt","https://example.com/from-csv","Old folder","alpha, beta",46224,"","","true"',
    ].join("\n");
    const form = new FormData();
    form.set("option", "preserve");
    form.set("file", new File([csv], "raindrop.csv", { type: "text/csv" }));
    const preview = await exports.default.fetch("https://later-gator.test/api/imports/preview", {
      method: "POST",
      headers: {
        cookie: client.cookie,
        origin: "https://later-gator.test",
        "x-csrf-token": client.csrf,
      },
      body: form,
    });
    expect(preview.status, await preview.clone().text()).toBe(201);
    const previewBody = await preview.json<{
      preview: { importId: string; validRows: number };
    }>();
    expect(previewBody.preview.validRows).toBe(1);

    const commit = await exports.default.fetch(
      `https://later-gator.test/api/imports/${previewBody.preview.importId}/commit`,
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: "{}",
      },
    );
    expect(commit.status, await commit.clone().text()).toBe(200);
    expect(await commit.json()).toMatchObject({ complete: true, committed: 1 });

    const imported = await env.DB
      .prepare(
        `SELECT b.title, b.favorite, f.slug AS folder
           FROM bookmarks b JOIN folders f ON f.id = b.folder_id
          WHERE b.normalized_url = ?`,
      )
      .bind("https://example.com/from-csv")
      .first();
    expect(imported).toMatchObject({ title: "CSV title", favorite: 1, folder: "imports" });
  });

  it("supports permanent-folder manual saves, export, trash, and permanent deletion", async () => {
    const client = await login();
    await finishSetup(client);
    const createResponse = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://example.com/manual-folder",
        title: "Manual folder bookmark",
        folderId: "folder_articles",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ bookmark: { id: string } }>();
    const saved = await env.DB
      .prepare("SELECT organization_policy, ai_state FROM bookmarks WHERE id = ?")
      .bind(created.bookmark.id)
      .first();
    expect(saved).toMatchObject({ organization_policy: "none", ai_state: "complete" });

    const thumbnailId = crypto.randomUUID();
    const thumbnailKey = `thumbnails/${created.bookmark.id}/${thumbnailId}.webp`;
    const thumbnailBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const now = new Date().toISOString();
    await env.THUMBNAILS.put(thumbnailKey, thumbnailBytes);
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO thumbnails (
            id, bookmark_id, object_key, media_type, width, height, byte_size,
            source_type, etag, state, created_at, updated_at
          ) VALUES (?, ?, ?, 'image/webp', 960, 1280, ?, 'user', ?, 'ready', ?, ?)`,
        )
        .bind(
          thumbnailId,
          created.bookmark.id,
          thumbnailKey,
          thumbnailBytes.byteLength,
          '"sha256-test"',
          now,
          now,
        ),
      env.DB
        .prepare("UPDATE bookmarks SET thumbnail_id = ? WHERE id = ?")
        .bind(thumbnailId, created.bookmark.id),
    ]);

    const listedResponse = await exports.default.fetch(
      "https://later-gator.test/api/bookmarks?sort=added_at&direction=desc",
      { headers: { cookie: client.cookie } },
    );
    const listed = await listedResponse.json<{
      bookmarks: {
        id: string;
        thumbnail_width: number | null;
        thumbnail_height: number | null;
      }[];
    }>();
    expect(listed.bookmarks.find((bookmark) => bookmark.id === created.bookmark.id)).toMatchObject({
      thumbnail_width: 960,
      thumbnail_height: 1280,
    });

    const preview = await exports.default.fetch(
      `https://later-gator.test/api/thumbnails/${created.bookmark.id}`,
      { headers: { cookie: client.cookie } },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(preview.headers.get("etag")).toBe('"sha256-test"');
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(thumbnailBytes);

    const unchangedPreview = await exports.default.fetch(
      `https://later-gator.test/api/thumbnails/${created.bookmark.id}`,
      {
        headers: {
          cookie: client.cookie,
          "if-none-match": '"sha256-test"',
        },
      },
    );
    expect(unchangedPreview.status).toBe(304);

    const related = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}/relationships`,
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ linkedUrl: "https://example.com/related-manual-folder" }),
      },
    );
    expect(related.status).toBe(201);
    const relatedBody = await related.json<{ relatedBookmarkId: string }>();
    const detail = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}`,
      { headers: { cookie: client.cookie } },
    );
    expect(await detail.json()).toMatchObject({
      bookmark: { relatedBookmarks: [{ id: relatedBody.relatedBookmarkId }] },
    });
    const unlinked = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}/relationships/${relatedBody.relatedBookmarkId}`,
      { method: "DELETE", headers: mutationHeaders(client) },
    );
    expect(unlinked.status).toBe(200);

    const exported = await exports.default.fetch(
      "https://later-gator.test/api/export?format=csv",
      { headers: { cookie: client.cookie } },
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect(await exported.text()).toContain("Manual folder bookmark");

    const trashed = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}/trash`,
      { method: "POST", headers: mutationHeaders(client), body: "{}" },
    );
    expect(trashed.status).toBe(200);
    const deleted = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks/${created.bookmark.id}/delete`,
      { method: "DELETE", headers: mutationHeaders(client) },
    );
    expect(deleted.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM bookmarks WHERE id = ?").bind(created.bookmark.id).first(),
    ).toBeNull();
    expect(await env.THUMBNAILS.get(thumbnailKey, "arrayBuffer")).toBeNull();
  });
});
