import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processResetStorage } from "../../src/v6/application/reset";

interface AuthenticatedClient {
  cookie: string;
  csrf: string;
}

async function login(): Promise<AuthenticatedClient> {
  const response = await exports.default.fetch("https://later-gator.test/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pass" }),
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

async function importRaindropCsv(
  client: AuthenticatedClient,
  csv: string,
  fileName: string,
  option: "reorganize" | "preserve" = "reorganize",
): Promise<string> {
  const form = new FormData();
  form.set("file", new File([csv], fileName, { type: "text/csv" }));
  form.set("option", option);
  const response = await exports.default.fetch("https://later-gator.test/api/imports", {
    method: "POST",
    headers: {
      cookie: client.cookie,
      origin: "https://later-gator.test",
      "x-csrf-token": client.csrf,
    },
    body: form,
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const body = await response.json<{ import: { id: string } }>();
  await vi.waitFor(async () => {
    const status = await env.DB
      .prepare("SELECT status FROM import_sessions WHERE id = ?")
      .bind(body.import.id)
      .first<{ status: string }>();
    expect(status?.status).toBe("committed");
  }, { timeout: 5000, interval: 20 });
  return body.import.id;
}

describe("v6 Worker foundation", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("serves an unauthenticated login page at the root", async () => {
    const response = await exports.default.fetch("https://later-gator.test/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Later Gator password");
    expect(html).toContain('rel="icon"');
    expect(html).toContain('type="image/svg+xml"');
    expect(html).not.toContain('minlength="10"');
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
          body: JSON.stringify({ password: "test-pass" }),
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

  it("defaults to stable date-added cursor pages and returns folder counts", async () => {
    const client = await login();
    await finishSetup(client);
    const ids: string[] = [];
    for (const [index, url] of [
      "https://pagination.test/page-oldest",
      "https://pagination.test/page-middle",
      "https://pagination.test/page-newest",
    ].entries()) {
      const response = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ url, title: `Page ${index.toString()}`, organizationPolicy: "none" }),
      });
      const body = await response.json<{ bookmark: { id: string } }>();
      ids.push(body.bookmark.id);
    }
    await env.DB.batch(
      ids.map((id, index) =>
        env.DB
          .prepare("UPDATE bookmarks SET added_at = ? WHERE id = ?")
          .bind(`2026-01-0${(index + 1).toString()}T00:00:00.000Z`, id),
      ),
    );

    const firstResponse = await exports.default.fetch(
      "https://later-gator.test/api/bookmarks?limit=2&hostname=pagination.test",
      { headers: { cookie: client.cookie } },
    );
    const first = await firstResponse.json<{
      bookmarks: { id: string }[];
      total: number;
      nextCursor: string | null;
    }>();
    expect(first.total).toBe(3);
    expect(first.bookmarks.map((bookmark) => bookmark.id)).toEqual([
      ids[2],
      ids[1],
    ]);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await exports.default.fetch(
      `https://later-gator.test/api/bookmarks?limit=2&hostname=pagination.test&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      { headers: { cookie: client.cookie } },
    );
    const second = await secondResponse.json<{
      bookmarks: { id: string }[];
      total: number;
      nextCursor: string | null;
    }>();
    expect(second.bookmarks.map((bookmark) => bookmark.id)).toEqual([ids[0]]);
    expect(second.total).toBe(3);
    expect(second.nextCursor).toBeNull();

    const bootstrapResponse = await exports.default.fetch(
      "https://later-gator.test/api/bootstrap",
      { headers: { cookie: client.cookie } },
    );
    const bootstrap = await bootstrapResponse.json<{
      state: { folders: { slug: string; bookmark_count: number }[]; trashCount: number };
    }>();
    const expectedUnsorted = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count
           FROM bookmarks
          WHERE folder_id = 'folder_unsorted' AND deleted_at IS NULL`,
      )
      .first();
    expect(
      bootstrap.state.folders.find((folder) => folder.slug === "unsorted"),
    ).toMatchObject({ bookmark_count: Number(expectedUnsorted?.count ?? 0) });
    expect(bootstrap.state.trashCount).toBe(0);
  });

  it("canonicalizes setup topics to lowercase hyphenated tags", async () => {
    const client = await login();
    const response = await exports.default.fetch(
      "https://later-gator.test/api/setup/complete",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({
          relevantTags: [
            "Machine Learning",
            "machine-learning",
            "History",
            "Religion & Philosophy",
            "Product Management",
            "Web Development",
          ],
          careerContext: "Engineer",
          aspirationContext: "Researcher",
          personalInstructions: null,
          timezone: "Asia/Kolkata",
        }),
      },
    );
    expect(response.status).toBe(200);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO tags (
            id, normalized_name, display_name, status, created_by, usage_count, created_at
          ) VALUES (?, 'Legacy Topic', 'Legacy Topic', 'active', 'user', 0, ?)`,
        )
        .bind(crypto.randomUUID(), now),
      env.DB
        .prepare(
          `INSERT INTO tags (
            id, normalized_name, display_name, status, created_by, usage_count, created_at
          ) VALUES (?, 'legacy-topic', 'legacy-topic', 'active', 'user', 0, ?)`,
        )
        .bind(crypto.randomUUID(), now),
    ]);
    await exports.default.fetch("https://later-gator.test/api/bootstrap", {
      headers: { cookie: client.cookie },
    });
    const tags = await env.DB
      .prepare(
        `SELECT normalized_name, display_name
           FROM tags
          WHERE normalized_name IN (
            'history', 'machine-learning', 'product-management',
            'religion-philosophy', 'web-development'
          )
          ORDER BY normalized_name`,
      )
      .all();
    expect(tags.results).toEqual([
      { normalized_name: "history", display_name: "history" },
      { normalized_name: "machine-learning", display_name: "machine-learning" },
      {
        normalized_name: "product-management",
        display_name: "product-management",
      },
      {
        normalized_name: "religion-philosophy",
        display_name: "religion-philosophy",
      },
      { normalized_name: "web-development", display_name: "web-development" },
    ]);
    const legacyTags = await env.DB
      .prepare(
        `SELECT normalized_name, display_name, COUNT(*) AS count
           FROM tags
          WHERE normalized_name = 'legacy-topic'
          GROUP BY normalized_name, display_name`,
      )
      .all();
    expect(legacyTags.results).toEqual([
      {
        normalized_name: "legacy-topic",
        display_name: "legacy-topic",
        count: 1,
      },
    ]);
  });

  it("accepts more than twenty seed topics and updates personal AI instructions", async () => {
    const client = await login();
    const setup = await exports.default.fetch(
      "https://later-gator.test/api/setup/complete",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({
          relevantTags: Array.from({ length: 25 }, (_, index) => `Topic ${index.toString()}`),
          careerContext: "Engineer",
          aspirationContext: "Researcher",
          personalInstructions: "Prefer practical sources.",
          timezone: "Asia/Kolkata",
        }),
      },
    );
    expect(setup.status).toBe(200);

    const update = await exports.default.fetch(
      "https://later-gator.test/api/profile/personal-instructions",
      {
        method: "PUT",
        headers: mutationHeaders(client),
        body: JSON.stringify({ personalInstructions: "Prefer rigorous primary sources." }),
      },
    );
    expect(update.status).toBe(200);

    const bootstrap = await exports.default.fetch("https://later-gator.test/api/bootstrap", {
      headers: { cookie: client.cookie },
    });
    expect(await bootstrap.json()).toMatchObject({
      state: { personalInstructions: "Prefer rigorous primary sources." },
    });
    const seeds = await env.DB
      .prepare(
        "SELECT COUNT(*) AS count FROM tags WHERE created_by = 'seed' AND normalized_name LIKE 'topic-%'",
      )
      .first();
    expect(seeds).toEqual({ count: 25 });
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

  it("repairs orphaned pending AI work during bootstrap and reports progress", async () => {
    const client = await login();
    await finishSetup(client);
    const createResponse = await exports.default.fetch(
      "https://later-gator.test/api/bookmarks",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({
          url: "https://example.com/recover-orphaned-ai",
          title: "Recover this AI job",
          organizationPolicy: "full",
        }),
      },
    );
    const created = await createResponse.json<{ bookmark: { id: string } }>();
    await env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = 'cancelled', last_safe_error_code = 'stale_job'
          WHERE bookmark_id = ?`,
      )
      .bind(created.bookmark.id)
      .run();
    await env.DB
      .prepare("UPDATE bookmarks SET ai_state = 'pending' WHERE id = ?")
      .bind(created.bookmark.id)
      .run();

    const bootstrapResponse = await exports.default.fetch("https://later-gator.test/api/bootstrap", {
      headers: { cookie: client.cookie },
    });
    const bootstrap = await bootstrapResponse.json<{
      state: { automationProgress: { total: number; pending: number } };
    }>();
    expect(bootstrap.state.automationProgress.total).toBeGreaterThan(0);
    expect(bootstrap.state.automationProgress.pending).toBeGreaterThan(0);
    const recovered = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count
           FROM background_jobs
          WHERE bookmark_id = ?
            AND state IN ('pending_dispatch', 'queued', 'running', 'waiting_provider', 'paused_owner')`,
      )
      .bind(created.bookmark.id)
      .first<{ count: number }>();
    expect(recovered).toEqual({ count: 1 });
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

  it("searches existing bookmarks for extension linking and rejects manual organization in Unsorted", async () => {
    const client = await login();
    await finishSetup(client);
    await exports.default.fetch("https://later-gator.test/api/automation/pause", {
      method: "PUT",
      headers: mutationHeaders(client),
      body: JSON.stringify({ paused: true, reason: "test" }),
    });
    const suffix = crypto.randomUUID();
    const targetResponse = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: `https://target.example/${suffix}`,
        title: `Extension target ${suffix}`,
        folderId: "folder_articles",
        organizationPolicy: "none",
      }),
    });
    expect(targetResponse.status).toBe(201);
    const target = await targetResponse.json<{ bookmark: { id: string; url: string } }>();

    const credentialResponse = await exports.default.fetch(
      "https://later-gator.test/api/capture/credentials",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ kind: "extension", name: "Test extension" }),
      },
    );
    expect(credentialResponse.status).toBe(201);
    const credential = await credentialResponse.json<{
      credential: { token: string; scopes: string[] };
    }>();
    expect(credential.credential.scopes).toContain("capture:bookmark-search");
    const captureHeaders = {
      authorization: `Bearer ${credential.credential.token}`,
      "content-type": "application/json",
    };

    const searchResponse = await exports.default.fetch(
      "https://later-gator.test/api/capture/bookmark-search",
      {
        method: "POST",
        headers: captureHeaders,
        body: JSON.stringify({ query: `Extension target ${suffix}` }),
      },
    );
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json<{
      bookmarks: { id: string; title: string; url: string; hostname: string; folder_name: string }[];
    }>();
    expect(search.bookmarks).toContainEqual({
      id: target.bookmark.id,
      title: `Extension target ${suffix}`,
      url: target.bookmark.url,
      hostname: "target.example",
      folder_name: "Articles",
    });

    const savedStatus = await exports.default.fetch(
      "https://later-gator.test/api/capture/bookmark-status",
      {
        method: "POST",
        headers: captureHeaders,
        body: JSON.stringify({ url: target.bookmark.url + "#section" }),
      },
    );
    expect(savedStatus.status).toBe(200);
    expect(await savedStatus.json()).toEqual({ ok: true, saved: true });
    const unsavedStatus = await exports.default.fetch(
      "https://later-gator.test/api/capture/bookmark-status",
      {
        method: "POST",
        headers: captureHeaders,
        body: JSON.stringify({ url: `https://unknown.example/${suffix}` }),
      },
    );
    expect(await unsavedStatus.json()).toEqual({ ok: true, saved: false });

    const unsortedResponse = await exports.default.fetch(
      "https://later-gator.test/api/capture/bookmarks",
      {
        method: "POST",
        headers: captureHeaders,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          url: `https://source.example/unsorted-${suffix}`,
          folderId: "folder_unsorted",
          tags: ["should-be-ignored"],
          linkedUrl: target.bookmark.url,
        }),
      },
    );
    expect(unsortedResponse.status).toBe(201);
    const unsorted = await unsortedResponse.json<{ bookmarkId: string; result: string }>();
    expect(unsorted.result).toBe("saved");
    const unsortedOrganization = await env.DB
      .prepare(
        `SELECT b.folder_id,
                (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.bookmark_id = b.id) AS tag_count,
                (SELECT COUNT(*) FROM bookmark_relationships r
                  WHERE r.left_bookmark_id = b.id OR r.right_bookmark_id = b.id) AS relationship_count
           FROM bookmarks b
          WHERE b.id = ?`,
      )
      .bind(unsorted.bookmarkId)
      .first<{ folder_id: string; tag_count: number; relationship_count: number }>();
    expect(unsortedOrganization).toEqual({
      folder_id: "folder_unsorted",
      tag_count: 0,
      relationship_count: 0,
    });

    const organizedResponse = await exports.default.fetch(
      "https://later-gator.test/api/capture/bookmarks",
      {
        method: "POST",
        headers: captureHeaders,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          url: `https://source.example/organized-${suffix}`,
          folderId: "folder_articles",
          tags: ["#new topic"],
          linkedUrl: target.bookmark.url,
        }),
      },
    );
    expect(organizedResponse.status).toBe(201);
    const organized = await organizedResponse.json<{ bookmarkId: string; result: string }>();
    expect(organized.result).toBe("saved_and_linked");
    const organizedCounts = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM bookmark_tags bt
             JOIN tags t ON t.id = bt.tag_id
            WHERE bt.bookmark_id = ? AND t.normalized_name = 'new-topic') AS tag_count,
           (SELECT COUNT(*) FROM bookmark_relationships r
            WHERE (r.left_bookmark_id = ? AND r.right_bookmark_id = ?)
               OR (r.left_bookmark_id = ? AND r.right_bookmark_id = ?)) AS relationship_count`,
      )
      .bind(
        organized.bookmarkId,
        organized.bookmarkId,
        target.bookmark.id,
        target.bookmark.id,
        organized.bookmarkId,
      )
      .first<{ tag_count: number; relationship_count: number }>();
    expect(organizedCounts).toEqual({ tag_count: 1, relationship_count: 1 });
  });

  it("supports both import modes and keeps every imported bookmark in Unsorted", async () => {
    const client = await login();
    await finishSetup(client);
    await exports.default.fetch("https://later-gator.test/api/automation/pause", {
      method: "PUT",
      headers: mutationHeaders(client),
      body: JSON.stringify({ paused: false }),
    });
    const fullLibraryCsv = [
      "id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite",
      'r-1,"Full export title","A note","An excerpt","https://x.com/from-full-csv","Old folder","alpha, beta",46224,"","","true"',
    ].join("\n");
    const folderOnlyCsv = [
      "id,title,note,excerpt,url,tags,created,cover,highlights,favorite",
      'r-2,"Folder export title","","","https://example.com/from-folder-csv","research",46225,"","","false"',
    ].join("\n");

    await importRaindropCsv(client, fullLibraryCsv, "full-library.csv", "preserve");
    await importRaindropCsv(client, folderOnlyCsv, "folder-only.csv");
    const bootstrapAfterImport = await exports.default.fetch(
      "https://later-gator.test/api/bootstrap",
      { headers: { cookie: client.cookie } },
    );
    expect(bootstrapAfterImport.status).toBe(200);

    const imported = await env.DB
      .prepare(
        `SELECT b.title, b.favorite, f.slug AS folder, b.description, b.note,
                b.organization_policy, b.ai_state
           FROM bookmarks b JOIN folders f ON f.id = b.folder_id
          WHERE b.normalized_url IN (?, ?)
          ORDER BY b.normalized_url`,
      )
      .bind("https://example.com/from-folder-csv", "https://x.com/from-full-csv")
      .all();
    expect(imported.results).toEqual([
      {
        title: "Folder export title",
        favorite: 0,
        folder: "unsorted",
        description: null,
        note: null,
        organization_policy: "full",
        ai_state: "pending",
      },
      {
        title: "Full export title",
        favorite: 0,
        folder: "unsorted",
        description: "An excerpt",
        note: null,
        organization_policy: "preserve",
        ai_state: "pending",
      },
    ]);
    const importedSideEffects = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*)
              FROM background_jobs j
              JOIN bookmarks b ON b.id = j.bookmark_id
             WHERE b.normalized_url IN (?, ?)) AS jobs,
           (SELECT COUNT(*)
              FROM thumbnail_jobs j
              JOIN bookmarks b ON b.id = j.bookmark_id
             WHERE b.normalized_url IN (?, ?)) AS thumbnail_jobs,
           (SELECT COUNT(*)
              FROM bookmark_tags bt
              JOIN bookmarks b ON b.id = bt.bookmark_id
             WHERE b.normalized_url IN (?, ?)) AS tag_links`,
      )
      .bind(
        "https://example.com/from-folder-csv",
        "https://x.com/from-full-csv",
        "https://example.com/from-folder-csv",
        "https://x.com/from-full-csv",
        "https://example.com/from-folder-csv",
        "https://x.com/from-full-csv",
      )
      .first();
    expect(importedSideEffects).toEqual({ jobs: 2, thumbnail_jobs: 2, tag_links: 2 });
    const ownerState = await env.DB
      .prepare("SELECT owner_ai_paused FROM app_state WHERE id = 1")
      .first();
    expect(ownerState).toEqual({ owner_ai_paused: 0 });
  });

  it("inserts a larger CSV in chunks with persisted row progress", async () => {
    const client = await login();
    await finishSetup(client);
    const pause = await exports.default.fetch(
      "https://later-gator.test/api/automation/pause",
      {
        method: "PUT",
        headers: mutationHeaders(client),
        body: JSON.stringify({ paused: true }),
      },
    );
    expect(pause.status).toBe(200);

    const csv = [
      "id,title,note,excerpt,url,tags,created,cover,highlights,favorite",
      ...Array.from(
        { length: 205 },
        (_, index) =>
          `row-${index.toString()},"Imported ${index.toString()}","","","https://example.com/import-chunk-${index.toString()}","ignored",46225,"","","false"`,
      ),
    ].join("\n");
    const importId = await importRaindropCsv(client, csv, "large-folder-export.csv");

    const completed = await env.DB
      .prepare(
        `SELECT status, total_rows, committed_rows, duplicate_rows, invalid_rows,
                file_sha256
           FROM import_sessions WHERE id = ?`,
      )
      .bind(importId)
      .first();
    expect(completed).toEqual({
      status: "committed",
      total_rows: 205,
      committed_rows: 205,
      duplicate_rows: 0,
      invalid_rows: 0,
      file_sha256: "",
    });
    const imported = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT added_at) AS timestamps
           FROM bookmarks
          WHERE normalized_url LIKE 'https://example.com/import-chunk-%'`,
      )
      .first();
    expect(imported).toEqual({ count: 205, timestamps: 1 });
    const stagedRows = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM import_rows WHERE import_id = ?")
      .bind(importId)
      .first();
    expect(stagedRows).toEqual({ count: 0 });
    const importedJobs = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count
           FROM background_jobs j
           JOIN bookmarks b ON b.id = j.bookmark_id
          WHERE b.normalized_url LIKE 'https://example.com/import-chunk-%'`,
      )
      .first();
    expect(importedJobs).toEqual({ count: 205 });
    const importedThumbnailJobs = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count
           FROM thumbnail_jobs j
           JOIN bookmarks b ON b.id = j.bookmark_id
          WHERE b.normalized_url LIKE 'https://example.com/import-chunk-%'`,
      )
      .first();
    expect(importedThumbnailJobs).toEqual({ count: 205 });
    const ownerState = await env.DB
      .prepare("SELECT owner_ai_paused FROM app_state WHERE id = 1")
      .first();
    expect(ownerState).toEqual({ owner_ai_paused: 1 });
  });

  it("uses normalized URLs to skip CSV and existing-library duplicates", async () => {
    const client = await login();
    await finishSetup(client);
    await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://example.com/import-duplicate",
        title: "Current title",
        organizationPolicy: "none",
      }),
    });
    const csv = [
      "id,title,note,excerpt,url,tags,created,cover,highlights,favorite",
      'r-duplicate,"Imported title","","","https://example.com/import-duplicate","ignored",46225,"","","false"',
      'r-new,"First CSV title","","","https://example.com/import-new","ignored",46225,"","","false"',
      'r-new-copy,"Second CSV title","","","https://example.com/import-new#fragment","ignored",46225,"","","false"',
    ].join("\n");
    const importId = await importRaindropCsv(client, csv, "folder-export.csv");

    const progress = await exports.default.fetch(
      `https://later-gator.test/api/imports/${importId}`,
      { headers: { cookie: client.cookie } },
    );
    expect(await progress.json()).toMatchObject({
      import: {
        status: "committed",
        total_rows: 3,
        valid_rows: 2,
        committed_rows: 1,
        duplicate_rows: 2,
        invalid_rows: 0,
        processed_rows: 3,
      },
    });
    const existing = await env.DB
      .prepare("SELECT title FROM bookmarks WHERE normalized_url = ?")
      .bind("https://example.com/import-duplicate")
      .first();
    expect(existing).toEqual({ title: "Current title" });
    const imported = await env.DB
      .prepare(
        `SELECT b.title, b.description, f.slug AS folder
           FROM bookmarks b
           JOIN folders f ON f.id = b.folder_id
          WHERE b.normalized_url = ?`,
      )
      .bind("https://example.com/import-new")
      .first();
    expect(imported).toEqual({
      title: "First CSV title",
      description: null,
      folder: "unsorted",
    });
  });

  it("requires only a URL column and makes re-upload the recovery path", async () => {
    const client = await login();
    await finishSetup(client);
    const csv = [
      "url,title",
      "not-a-url,Invalid",
      "https://example.com/minimal,Minimal export",
    ].join("\n");
    const firstImportId = await importRaindropCsv(client, csv, "minimal.csv");
    const first = await env.DB
      .prepare(
        `SELECT committed_rows, duplicate_rows, invalid_rows,
                committed_rows + duplicate_rows + invalid_rows AS processed_rows
           FROM import_sessions WHERE id = ?`,
      )
      .bind(firstImportId)
      .first();
    expect(first).toEqual({
      committed_rows: 1,
      duplicate_rows: 0,
      invalid_rows: 1,
      processed_rows: 2,
    });

    const secondImportId = await importRaindropCsv(client, csv, "minimal-again.csv");
    const second = await env.DB
      .prepare(
        "SELECT committed_rows, duplicate_rows, invalid_rows FROM import_sessions WHERE id = ?",
      )
      .bind(secondImportId)
      .first();
    expect(second).toEqual({
      committed_rows: 0,
      duplicate_rows: 1,
      invalid_rows: 1,
    });

    const wrongFile = new FormData();
    wrongFile.set("file", new File(["title\nNo URL"], "wrong.csv", { type: "text/csv" }));
    wrongFile.set("option", "reorganize");
    const rejected = await exports.default.fetch("https://later-gator.test/api/imports", {
      method: "POST",
      headers: {
        cookie: client.cookie,
        origin: "https://later-gator.test",
        "x-csrf-token": client.csrf,
      },
      body: wrongFile,
    });
    expect(rejected.status).toBe(422);

    await env.DB
      .prepare(
        `INSERT INTO import_sessions (
          id, status, option, file_name, file_size, file_sha256, total_rows,
          valid_rows, created_at, expires_at
        ) VALUES (?, 'committing', 'reorganize', 'legacy.csv', 100, ?, 1, 1, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        "legacy-preview-hash",
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      )
      .run();
    const bootstrap = await exports.default.fetch("https://later-gator.test/api/bootstrap", {
      headers: { cookie: client.cookie },
    });
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({ state: { activeImport: null } });
  });

  it("serves standard library dialogs and expires unauthenticated API cookies", async () => {
    const anonymousMissingPage = await exports.default.fetch(
      new Request("https://later-gator.test/favicon.ico", { redirect: "manual" }),
    );
    expect(anonymousMissingPage.status).toBe(303);
    expect(anonymousMissingPage.headers.get("location")).toBe("https://later-gator.test/");
    expect(anonymousMissingPage.headers.getSetCookie().join(";")).toContain("Max-Age=0");

    const client = await login();
    await finishSetup(client);
    const dashboard = await exports.default.fetch("https://later-gator.test/dashboard", {
      headers: { cookie: client.cookie },
    });
    const html = await dashboard.text();
    expect(html).toContain('id="filterDialog"');
    expect(html).toContain('id="tagSuggestions"');
    expect(html).toContain('id="topicsDialog"');
    expect(html).toContain('id="topicDeleteSelected"');
    expect(html).not.toContain('id="selectModeButton"');
    expect(html).not.toContain('class="busy-overlay"');
    expect(html).toContain('id="detailExternalLink"');
    expect(html).not.toContain('id="editModeButton"');

    await env.DB.prepare("DELETE FROM sessions").run();
    const expired = await exports.default.fetch("https://later-gator.test/api/bootstrap", {
      headers: { cookie: client.cookie },
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.getSetCookie().join(";")).toContain("Max-Age=0");
    // The frontend is now built to content-hashed static assets, so the page
    // must reference them and the asset layer must serve them.
    const assetPage = await exports.default.fetch("https://later-gator.test/dashboard", {
      headers: { cookie: client.cookie },
    });
    const dashboardHtml = await assetPage.text();
    expect(dashboardHtml).toMatch(/<link rel="stylesheet" href="\/assets\/app\.[A-Z0-9]+\.css">/u);
    expect(dashboardHtml).toMatch(/<script type="module" src="\/assets\/main\.[A-Z0-9]+\.js"><\/script>/u);
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
      `https://later-gator.test/api/thumbnails/${created.bookmark.id}/${thumbnailId}`,
      { headers: { cookie: client.cookie } },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(preview.headers.get("etag")).toBe('"sha256-test"');
    expect(preview.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(thumbnailBytes);

    const unchangedPreview = await exports.default.fetch(
      `https://later-gator.test/api/thumbnails/${created.bookmark.id}/${thumbnailId}`,
      {
        headers: {
          cookie: client.cookie,
          "if-none-match": '"sha256-test"',
        },
      },
    );
    expect(unchangedPreview.status).toBe(304);

    const unversionedPreview = await exports.default.fetch(
      `https://later-gator.test/api/thumbnails/${created.bookmark.id}`,
      { headers: { cookie: client.cookie } },
    );
    expect(unversionedPreview.status).toBe(404);

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

  it("requires explicit confirmation and resets the deployment to setup", async () => {
    const client = await login();
    await finishSetup(client);
    const created = await exports.default.fetch("https://later-gator.test/api/bookmarks", {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        url: "https://example.com/reset-me",
        organizationPolicy: "none",
        tags: ["temporary"],
      }),
    });
    expect(created.status).toBe(201);
    await env.THUMBNAILS.put("thumbnails/test/reset.webp", new Uint8Array([1, 2, 3]));

    const rejected = await exports.default.fetch(
      "https://later-gator.test/api/testing/reset",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ confirmation: "delete" }),
      },
    );
    expect(rejected.status).toBe(400);

    const reset = await exports.default.fetch(
      "https://later-gator.test/api/testing/reset",
      {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ confirmation: "DELETE EVERYTHING" }),
      },
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ redirectTo: "/setup" });
    expect(
      await env.DB.prepare("SELECT setup_status FROM app_state WHERE id = 1").first(),
    ).toEqual({ setup_status: "setup_incomplete" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM bookmarks").first()).toEqual({
      count: 0,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tags").first()).toEqual({
      count: 0,
    });
    const setup = await exports.default.fetch("https://later-gator.test/setup", {
      headers: { cookie: client.cookie },
    });
    expect(setup.status).toBe(200);
    expect(await processResetStorage(env)).toBe("complete");
    expect(await env.THUMBNAILS.get("thumbnails/test/reset.webp")).toBeNull();
  });
});
