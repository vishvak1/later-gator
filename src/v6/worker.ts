import {
  backgroundMessageSchema,
  automationPauseInputSchema,
  bookmarkListQuerySchema,
  completeSetupInputSchema,
  captureCredentialInputSchema,
  createBookmarkInputSchema,
  createTagInputSchema,
  importStartInputSchema,
  loginInputSchema,
  providerActivationInputSchema,
  providerCandidateInputSchema,
  resetApplicationInputSchema,
  relationshipInputSchema,
  updateBookmarkInputSchema,
} from "./domain/schemas";
import {
  completeSetup,
  createTag,
  createBookmark,
  dispatchJob,
  getBookmark,
  getBookmarkDetails,
  getBootstrapState,
  listBookmarkPage,
  permanentlyDeleteBookmark,
  relateBookmarks,
  restoreTag,
  retireTag,
  setBookmarkDeleted,
  setOwnerPause,
  unrelateBookmarks,
  updateBookmark,
} from "./adapters/library-repository";
import {
  dashboardPage,
  loginPage,
  settingsPage,
  setupPage,
} from "./routes/pages";
import { appCss, appJs } from "./routes/assets";
import { apiError, json, readJson, redirect } from "./routes/responses";
import { unlockOrInitializeVault } from "./security/password-vault";
import {
  createSession,
  expiredSessionCookie,
  loadSession,
  originMatches,
  requireCsrf,
  revokeSession,
  type DashboardSession,
} from "./security/sessions";
import { organizeBookmarkJob } from "./application/organize-bookmark";
import {
  cancelImport,
  getImportStatus,
  processImportThumbnailWork,
  processImportWork,
  previewRaindropCsv,
  startImport,
} from "./application/imports";
import {
  processResetStorage,
  resetApplication,
} from "./application/reset";
import { ingestThumbnailCandidate } from "./application/thumbnails";
import {
  captureBookmark,
  captureOptions,
  capturePreflight,
} from "./routes/capture";
import {
  issueCaptureCredential,
  revokeCaptureCredential,
} from "./security/capture-credentials";
import {
  deleteProviderCredential,
  saveProviderCredential,
} from "./security/credential-vault";
import {
  OrganizationProviderError,
  testProviderConnection,
} from "./adapters/organization-providers";
import { handleMcp, rotateMcpCredential } from "./routes/mcp";
import { sha256Base64 } from "./security/encoding";
import { repairOrganizationBacklog } from "./application/automation";

interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  session: DashboardSession;
}

async function setupComplete(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT setup_status FROM app_state WHERE id = 1")
    .first<{ setup_status: string }>();
  return row?.setup_status === "ready";
}

function parseFormPassword(request: Request): Promise<string | null> {
  return request.formData().then((form) => {
    const value = form.get("password");
    return typeof value === "string" ? value : null;
  });
}

async function loginClientHash(request: Request): Promise<string> {
  const client = request.headers.get("cf-connecting-ip") ?? "local";
  return sha256Base64(`login-client:${client}`);
}

async function loginIsBlocked(request: Request, db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT blocked_until FROM login_attempts WHERE client_hash = ?")
    .bind(await loginClientHash(request))
    .first<{ blocked_until: string | null }>();
  return row?.blocked_until !== null &&
    row?.blocked_until !== undefined &&
    Date.parse(row.blocked_until) > Date.now();
}

async function recordLoginFailure(request: Request, db: D1Database): Promise<void> {
  const clientHash = await loginClientHash(request);
  const existing = await db
    .prepare(
      "SELECT window_started_at, failure_count FROM login_attempts WHERE client_hash = ?",
    )
    .bind(clientHash)
    .first<{ window_started_at: string; failure_count: number }>();
  const now = new Date();
  const inWindow =
    existing !== null && Date.parse(existing.window_started_at) > now.getTime() - 15 * 60 * 1000;
  const failureCount = inWindow ? existing.failure_count + 1 : 1;
  const blockedUntil =
    failureCount >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
  await db
    .prepare(
      `INSERT INTO login_attempts (
        client_hash, window_started_at, failure_count, blocked_until
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_hash) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        failure_count = excluded.failure_count,
        blocked_until = excluded.blocked_until`,
    )
    .bind(clientHash, inWindow ? existing.window_started_at : now.toISOString(), failureCount, blockedUntil)
    .run();
}

async function login(request: Request, env: Env): Promise<Response> {
  if (await loginIsBlocked(request, env.DB)) {
    return apiError(429, "login_rate_limited", "Wait a few minutes and try again.");
  }
  let password: string | null;
  try {
    if (request.headers.get("content-type")?.includes("application/json") === true) {
      const parsed = loginInputSchema.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success) return apiError(400, "invalid_login", "Enter your Later Gator password.");
      password = parsed.data.password;
    } else {
      password = await parseFormPassword(request);
      if (password === null || password.length === 0 || password.length > 1024) {
        return loginPage("invalid");
      }
    }
  } catch {
    return apiError(400, "invalid_login", "Enter your Later Gator password.");
  }

  let unlocked: Awaited<ReturnType<typeof unlockOrInitializeVault>>;
  try {
    unlocked = await unlockOrInitializeVault(env.DB, env, password);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "authentication_vault_unavailable",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    if (request.headers.get("content-type")?.includes("application/json") === true) {
      return apiError(
        503,
        "authentication_unavailable",
        "Secure authentication is temporarily unavailable.",
      );
    }
    return loginPage("unavailable");
  }
  if (unlocked === null) {
    await recordLoginFailure(request, env.DB);
    if (request.headers.get("content-type")?.includes("application/json") === true) {
      return apiError(401, "invalid_password", "That password was not accepted.");
    }
    return loginPage("invalid");
  }
  await env.DB
    .prepare("DELETE FROM login_attempts WHERE client_hash = ?")
    .bind(await loginClientHash(request))
    .run();

  const session = await createSession(env.DB, unlocked.rawDataKey);
  const headers = new Headers();
  headers.append("set-cookie", session.cookie);
  headers.append(
    "set-cookie",
    `lg_csrf=${session.csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=${(
      14 *
      24 *
      60 *
      60
    ).toString()}`,
  );

  if (request.headers.get("content-type")?.includes("application/json") === true) {
    return json(
      {
        ok: true,
        csrfToken: session.csrfToken,
        redirectTo: (await setupComplete(env.DB)) ? "/dashboard" : "/setup",
      },
      { headers },
    );
  }
  headers.set("location", (await setupComplete(env.DB)) ? "/dashboard" : "/setup");
  return new Response(null, { status: 303, headers });
}

async function requireMutationSecurity(context: RouteContext): Promise<Response | null> {
  if (!originMatches(context.request)) {
    return apiError(403, "origin_rejected", "Reload Later Gator and try again.");
  }
  if (!(await requireCsrf(context.request, context.env.DB, context.session))) {
    return apiError(403, "csrf_rejected", "Reload Later Gator and try again.");
  }
  return null;
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function importIsActive(db: D1Database): Promise<boolean> {
  return (
    (await db
      .prepare(
        `SELECT 1
           FROM import_sessions
          WHERE status IN ('preview', 'committing')
          LIMIT 1`,
      )
      .first()) !== null
  );
}

function csvCell(value: unknown): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? value.toString()
      : "";
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportLibrary(env: Env, format: string): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `SELECT b.id, b.url, b.title, b.description, b.note, f.name AS folder,
              b.favorite, b.hostname, b.source_type, b.ai_state, b.source_created_at,
              b.added_at, b.modified_at, b.deleted_at,
              GROUP_CONCAT(CASE WHEN t.status = 'active' THEN t.display_name END, ',') AS tags
         FROM bookmarks b
         JOIN folders f ON f.id = b.folder_id
         LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
         LEFT JOIN tags t ON t.id = bt.tag_id
        GROUP BY b.id
        ORDER BY b.added_at, b.id`,
    )
    .all();
  if (format === "csv") {
    const headers = [
      "id",
      "url",
      "title",
      "description",
      "note",
      "folder",
      "tags",
      "favorite",
      "hostname",
      "source_type",
      "ai_state",
      "source_created_at",
      "added_at",
      "modified_at",
      "deleted_at",
    ];
    const body = [
      headers.map(csvCell).join(","),
      ...rows.results.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\r\n");
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="later-gator-export.csv"',
        "cache-control": "no-store",
      },
    });
  }
  return new Response(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), bookmarks: rows.results }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="later-gator-export.json"',
      "cache-control": "no-store",
    },
  });
}

function installationGuide(kind: "chrome" | "firefox" | "ios"): Response {
  const copy =
    kind === "ios"
      ? `<h1>Install the iOS Share Sheet Shortcut</h1><ol><li>In Later Gator Settings, generate an iOS connection.</li><li>Create a Shortcut that accepts URLs from the Share Sheet.</li><li>Add “Get Contents of URL”: POST the shared URL and a generated UUID as JSON to the displayed endpoint.</li><li>Add the Authorization header as Bearer plus the displayed token.</li><li>If result is saved, show “Saved to Later Gator”; if already_saved, show “Already saved in Later Gator”; otherwise show “Failed to save to Later Gator”.</li></ol><p>The maintained request template is in <code>shortcuts/ios/request-template.json</code>.</p>`
      : `<h1>Install the ${kind === "chrome" ? "Chrome" : "Firefox"} extension</h1><ol><li>Download or clone the Later Gator repository.</li><li>Open the browser's extension debugging page.</li><li>Load <code>extension/${kind}</code> as an unpacked or temporary extension.</li><li>Open the popup, enter this Later Gator deployment URL and the extension token generated in Settings.</li><li>Approve access only to this deployment host.</li></ol><p>The extension asks for the active tab only when you open it and does not request browsing history.</p>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Later Gator installation</title><link rel="stylesheet" href="/app.css"></head><body><main class="settings-shell"><section class="panel">${copy}<p><a href="/settings">Back to Settings</a></p></section></main></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function handleAuthenticatedApi(context: RouteContext): Promise<Response> {
  const { request, env, url } = context;

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (await repairOrganizationBacklog(env)) {
      await env.BACKGROUND_QUEUE.send({ version: 1, type: "dispatch_pending" }).catch(() => undefined);
    }
    return json({ ok: true, state: await getBootstrapState(env.DB) });
  }

  if (request.method === "POST" && url.pathname === "/api/testing/reset") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = resetApplicationInputSchema.safeParse(await readJson(request, 4 * 1024));
    } catch {
      return apiError(400, "reset_confirmation_required", "Type DELETE EVERYTHING to confirm.");
    }
    if (!parsed.success) {
      return apiError(400, "reset_confirmation_required", "Type DELETE EVERYTHING to confirm.");
    }
    await resetApplication(env, context.session.idHash);
    return json({ ok: true, redirectTo: "/setup" });
  }

  const importControlRequest =
    /^\/api\/imports\/[0-9a-f-]+\/(?:commit|cancel)$/iu.test(url.pathname);
  if (
    request.method !== "GET" &&
    !importControlRequest &&
    (await importIsActive(env.DB))
  ) {
    return apiError(
      409,
      "import_in_progress",
      "The library is read-only until the active import finishes.",
    );
  }

  if (request.method === "POST" && url.pathname === "/api/setup/complete") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = completeSetupInputSchema.safeParse(await readJson(request));
    } catch {
      return apiError(400, "invalid_json", "The setup information could not be read.");
    }
    if (!parsed.success) {
      return apiError(400, "invalid_setup", "Complete the required setup fields.");
    }
    try {
      await completeSetup(env.DB, parsed.data);
      return json({ ok: true, redirectTo: "/dashboard" });
    } catch (error) {
      if (error instanceof Error && error.message === "not_enough_distinct_tags") {
        return apiError(400, "not_enough_distinct_tags", "Choose five distinct tags.");
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/bookmarks") {
    const parsed = bookmarkListQuerySchema.safeParse(queryObject(url));
    if (!parsed.success) {
      return apiError(400, "invalid_filters", "One or more bookmark filters are invalid.");
    }
    try {
      const pageResult = await listBookmarkPage(env.DB, parsed.data);
      return json({ ok: true, ...pageResult });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_bookmark_cursor") {
        return apiError(400, "invalid_cursor", "The bookmark page cursor is invalid.");
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/bookmarks") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = createBookmarkInputSchema.safeParse(await readJson(request));
    } catch (error) {
      return apiError(
        error instanceof Error && error.message === "request_too_large" ? 413 : 400,
        "invalid_bookmark",
        "The bookmark could not be read.",
      );
    }
    if (!parsed.success) {
      return apiError(400, "invalid_bookmark", "Check the bookmark fields and try again.");
    }
    try {
      const createInput =
        parsed.data.folderId !== undefined && parsed.data.folderId !== "folder_unsorted"
          ? { ...parsed.data, organizationPolicy: "none" as const }
          : parsed.data;
      const created = await createBookmark(env.DB, createInput, "dashboard");
      const jobIds = created.jobId === null ? [] : [created.jobId];
      let linkedBookmarkId: string | null = null;
      if (parsed.data.linkedUrl !== undefined && parsed.data.linkedUrl !== null) {
        const linked = await createBookmark(
          env.DB,
          {
            url: parsed.data.linkedUrl,
            folderId: "folder_unsorted",
            organizationPolicy: "full",
          },
          "linked",
        );
        if (linked.bookmark.id === created.bookmark.id) {
          return apiError(400, "self_relationship", "Linked to must be a different URL.");
        }
        await relateBookmarks(env.DB, created.bookmark.id, linked.bookmark.id);
        linkedBookmarkId = linked.bookmark.id;
        if (linked.jobId !== null) jobIds.push(linked.jobId);
      }
      if (
        created.created &&
        parsed.data.thumbnailUrl !== undefined &&
        parsed.data.thumbnailUrl !== null
      ) {
        await ingestThumbnailCandidate(
          env,
          created.bookmark.id,
          parsed.data.thumbnailUrl,
          "user",
        );
      }
      const dispatches = await Promise.all(
        jobIds.map((jobId) => dispatchJob(env.DB, env.BACKGROUND_QUEUE, jobId)),
      );
      return json(
        {
          ok: true,
          bookmark: (await getBookmark(env.DB, created.bookmark.id)) ?? created.bookmark,
          created: created.created,
          linkedBookmarkId,
          automation:
            jobIds.length === 0
              ? "not_requested"
              : dispatches.every(Boolean)
                ? "queued"
                : "pending",
        },
        { status: created.created ? 201 : 200 },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "UnsafeBookmarkUrlError") {
        return apiError(400, "unsafe_url", error.message);
      }
      throw error;
    }
  }

  const bookmarkMatch = /^\/api\/bookmarks\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (bookmarkMatch !== null) {
    const bookmarkId = bookmarkMatch[1];
    if (bookmarkId === undefined) return apiError(404, "not_found", "Bookmark not found.");
    if (request.method === "GET") {
      const bookmark = await getBookmarkDetails(env.DB, bookmarkId);
      return bookmark === null
        ? apiError(404, "not_found", "Bookmark not found.")
        : json({ ok: true, bookmark });
    }
    if (request.method === "PATCH") {
      const securityError = await requireMutationSecurity(context);
      if (securityError !== null) return securityError;
      let parsed;
      try {
        parsed = updateBookmarkInputSchema.safeParse(await readJson(request));
      } catch {
        return apiError(400, "invalid_bookmark", "The bookmark update could not be read.");
      }
      if (!parsed.success) {
        return apiError(400, "invalid_bookmark", "Check the bookmark fields and try again.");
      }
      let result;
      try {
        result = await updateBookmark(env.DB, bookmarkId, parsed.data);
      } catch (error) {
        if (error instanceof Error && error.message === "retired_tag_requires_restore") {
          return apiError(
            409,
            "tag_retired",
            "A retired tag must be restored explicitly before it can be used again.",
          );
        }
        throw error;
      }
      if (result === null) return apiError(404, "not_found", "Bookmark not found.");
      if (result === "revision_conflict") {
        return apiError(
          409,
          "bookmark_changed",
          "This bookmark changed. Reload it and try again.",
        );
      }
      return json({ ok: true, bookmark: result });
    }
  }

  const relationshipsMatch = /^\/api\/bookmarks\/([0-9a-f-]+)\/relationships$/iu.exec(
    url.pathname,
  );
  if (request.method === "POST" && relationshipsMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const bookmarkId = relationshipsMatch[1];
    if (bookmarkId === undefined || (await getBookmark(env.DB, bookmarkId)) === null) {
      return apiError(404, "not_found", "Bookmark not found.");
    }
    let parsed;
    try {
      parsed = relationshipInputSchema.safeParse(await readJson(request));
    } catch {
      return apiError(400, "invalid_relationship", "The related bookmark could not be read.");
    }
    if (!parsed.success) {
      return apiError(400, "invalid_relationship", "Enter a valid related bookmark URL.");
    }
    try {
      const linked = await createBookmark(
        env.DB,
        {
          url: parsed.data.linkedUrl,
          folderId: "folder_unsorted",
          organizationPolicy: "full",
        },
        "linked",
      );
      if (linked.bookmark.id === bookmarkId) {
        return apiError(400, "self_relationship", "A bookmark cannot link to itself.");
      }
      const created = await relateBookmarks(env.DB, bookmarkId, linked.bookmark.id);
      if (linked.jobId !== null) {
        await dispatchJob(env.DB, env.BACKGROUND_QUEUE, linked.jobId);
      }
      return json(
        { ok: true, created, relatedBookmarkId: linked.bookmark.id },
        { status: created ? 201 : 200 },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "UnsafeBookmarkUrlError") {
        return apiError(400, "unsafe_url", error.message);
      }
      throw error;
    }
  }

  const relationshipDeleteMatch =
    /^\/api\/bookmarks\/([0-9a-f-]+)\/relationships\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "DELETE" && relationshipDeleteMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const bookmarkId = relationshipDeleteMatch[1];
    const relatedBookmarkId = relationshipDeleteMatch[2];
    if (
      bookmarkId === undefined ||
      relatedBookmarkId === undefined ||
      !(await unrelateBookmarks(env.DB, bookmarkId, relatedBookmarkId))
    ) {
      return apiError(404, "relationship_not_found", "Related bookmark link not found.");
    }
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/tags") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = createTagInputSchema.safeParse(await readJson(request, 4 * 1024));
    } catch {
      return apiError(400, "invalid_tag", "The tag could not be read.");
    }
    if (!parsed.success) return apiError(400, "invalid_tag", "Enter a valid tag name.");
    try {
      const tag = await createTag(env.DB, parsed.data.name);
      return json({ ok: true, tag }, { status: tag.created ? 201 : 200 });
    } catch (error) {
      if (error instanceof Error && error.message === "retired_tag_requires_restore") {
        return apiError(
          409,
          "tag_retired",
          "This tag was deleted globally. Restore it explicitly before reuse.",
        );
      }
      if (error instanceof Error && error.message === "invalid_tag_name") {
        return apiError(400, "invalid_tag", "Use a lowercase word or hyphenated tag.");
      }
      throw error;
    }
  }

  const tagMatch = /^\/api\/tags\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "DELETE" && tagMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const tagId = tagMatch[1];
    if (tagId === undefined) return apiError(404, "not_found", "Tag not found.");
    const result = await retireTag(env.DB, tagId);
    return result.retired
      ? json({ ok: true, affectedBookmarks: result.affectedBookmarks })
      : apiError(404, "not_found", "Tag not found.");
  }

  const tagRestoreMatch = /^\/api\/tags\/([0-9a-f-]+)\/restore$/iu.exec(url.pathname);
  if (request.method === "POST" && tagRestoreMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const tagId = tagRestoreMatch[1];
    if (tagId === undefined || !(await restoreTag(env.DB, tagId))) {
      return apiError(404, "not_found", "Retired tag not found.");
    }
    return json({ ok: true });
  }

  if (request.method === "PUT" && url.pathname === "/api/automation/pause") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = automationPauseInputSchema.safeParse(await readJson(request, 4 * 1024));
    } catch {
      return apiError(400, "invalid_pause", "The automation request could not be read.");
    }
    if (!parsed.success) return apiError(400, "invalid_pause", "Choose whether AI is paused.");
    const jobIds = await setOwnerPause(
      env.DB,
      parsed.data.paused,
      parsed.data.reason ?? null,
    );
    const dispatchResults = await Promise.all(
      jobIds.map((jobId) => dispatchJob(env.DB, env.BACKGROUND_QUEUE, jobId)),
    );
    return json({
      ok: true,
      paused: parsed.data.paused,
      redispatched: dispatchResults.filter(Boolean).length,
      pendingDispatch: dispatchResults.filter((result) => !result).length,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/providers/test") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = providerCandidateInputSchema.safeParse(await readJson(request, 24 * 1024));
    } catch {
      return apiError(400, "invalid_provider", "The provider settings could not be read.");
    }
    if (!parsed.success) return apiError(400, "invalid_provider", "Check the provider and model.");
    if (parsed.data.provider !== "workers-ai" && parsed.data.credential !== null && parsed.data.credential !== undefined) {
      await saveProviderCredential(
        env,
        context.session.rawDataKey,
        parsed.data.provider,
        parsed.data.credential,
      );
    }
    const now = new Date().toISOString();
    try {
      await testProviderConnection(env, parsed.data.provider, parsed.data.model);
      await env.DB
        .prepare(
          `INSERT INTO provider_candidates (
            id, provider, model, tested_at, safe_status, safe_error_code
          ) VALUES (1, ?, ?, ?, 'passed', NULL)
          ON CONFLICT(id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            tested_at = excluded.tested_at,
            safe_status = excluded.safe_status,
            safe_error_code = NULL`,
        )
        .bind(parsed.data.provider, parsed.data.model, now)
        .run();
      return json({ ok: true, status: "passed" });
    } catch (error) {
      const safeCode =
        error instanceof OrganizationProviderError ? error.safeCode : "provider_test_failed";
      await env.DB
        .prepare(
          `INSERT INTO provider_candidates (
            id, provider, model, tested_at, safe_status, safe_error_code
          ) VALUES (1, ?, ?, ?, 'failed', ?)
          ON CONFLICT(id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            tested_at = excluded.tested_at,
            safe_status = excluded.safe_status,
            safe_error_code = excluded.safe_error_code`,
        )
        .bind(parsed.data.provider, parsed.data.model, now, safeCode)
        .run();
      return apiError(422, safeCode, "The provider test failed. The active provider was not changed.");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/providers/activate") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = providerActivationInputSchema.safeParse(await readJson(request, 4 * 1024));
    } catch {
      return apiError(400, "invalid_provider", "The provider settings could not be read.");
    }
    if (!parsed.success) return apiError(400, "invalid_provider", "Check the provider and model.");
    const candidate = await env.DB
      .prepare(
        `SELECT 1 FROM provider_candidates
          WHERE id = 1 AND provider = ? AND model = ? AND safe_status = 'passed'`,
      )
      .bind(parsed.data.provider, parsed.data.model)
      .first();
    if (candidate === null) {
      return apiError(409, "provider_not_tested", "Test this provider and model before activation.");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE provider_settings
              SET provider = ?, model = ?, config_version = config_version + 1,
                  operational_status = 'ready', last_safe_error_code = NULL, updated_at = ?
            WHERE id = 1`,
        )
        .bind(parsed.data.provider, parsed.data.model, now),
      env.DB
        .prepare(
          `UPDATE background_jobs
              SET provider = ?, model = ?,
                  state = CASE
                    WHEN state = 'waiting_provider'
                      AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0
                    THEN 'pending_dispatch'
                    ELSE state
                  END,
                  last_safe_error_code = NULL,
                  updated_at = ?
            WHERE state IN (
              'pending_dispatch', 'queued', 'waiting_provider', 'paused_edit', 'paused_owner'
            )`,
        )
        .bind(parsed.data.provider, parsed.data.model, now),
      env.DB
        .prepare(
          `UPDATE bookmarks
              SET ai_state = CASE
                WHEN ai_state = 'waiting_provider'
                  AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0
                THEN 'pending'
                ELSE ai_state
              END
            WHERE ai_state IN ('pending', 'waiting_provider', 'paused_edit', 'paused_owner')`,
        ),
    ]);
    const jobs = await env.DB
      .prepare("SELECT id FROM background_jobs WHERE state = 'pending_dispatch' ORDER BY created_at")
      .all<{ id: string }>();
    const dispatches = await Promise.all(
      jobs.results.map((job) => dispatchJob(env.DB, env.BACKGROUND_QUEUE, job.id)),
    );
    return json({
      ok: true,
      redispatched: dispatches.filter(Boolean).length,
      pendingDispatch: dispatches.filter((result) => !result).length,
    });
  }

  if (request.method === "DELETE" && /^\/api\/providers\/(openai|anthropic)$/u.test(url.pathname)) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const provider = url.pathname.endsWith("openai") ? "openai" : "anthropic";
    const active = await env.DB
      .prepare("SELECT provider FROM provider_settings WHERE id = 1")
      .first<{ provider: string }>();
    if (active?.provider === provider) {
      return apiError(409, "provider_active", "Switch providers before removing this credential.");
    }
    await deleteProviderCredential(env.DB, provider);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/imports/preview") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 11 * 1024 * 1024) {
      return apiError(413, "csv_too_large", "The CSV must be 10 MiB or smaller.");
    }
    try {
      const form = await request.formData();
      const file = form.get("file");
      const option = form.get("option");
      if (!(file instanceof File) || (option !== "reorganize" && option !== "preserve")) {
        return apiError(400, "invalid_import", "Choose a Raindrop CSV and import option.");
      }
      return json(
        { ok: true, preview: await previewRaindropCsv(env.DB, file, option) },
        { status: 201 },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_import";
      const status = code === "csv_too_large" || code === "csv_too_many_rows" ? 413 : 422;
      return apiError(status, code, "The Raindrop CSV could not be previewed.");
    }
  }

  const importMatch = /^\/api\/imports\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "GET" && importMatch !== null) {
    const importId = importMatch[1];
    if (importId === undefined) return apiError(404, "not_found", "Import not found.");
    const status = await getImportStatus(env.DB, importId);
    return status === null ? apiError(404, "not_found", "Import not found.") : json({ ok: true, import: status });
  }
  const importCommitMatch = /^\/api\/imports\/([0-9a-f-]+)\/commit$/iu.exec(url.pathname);
  if (request.method === "POST" && importCommitMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const importId = importCommitMatch[1];
    if (importId === undefined) return apiError(404, "not_found", "Import not found.");
    try {
      const parsed = importStartInputSchema.safeParse(await readJson(request, 512 * 1024));
      if (!parsed.success) {
        return apiError(400, "invalid_import", "The import request could not be read.");
      }
      return json({
        ok: true,
        import: await startImport(env, importId),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "import_failed";
      return apiError(
        code === "import_not_found" ? 404 : 409,
        code,
        "The import could not continue.",
      );
    }
  }
  const importCancelMatch = /^\/api\/imports\/([0-9a-f-]+)\/cancel$/iu.exec(url.pathname);
  if (request.method === "POST" && importCancelMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const importId = importCancelMatch[1];
    if (importId === undefined) return apiError(404, "not_found", "Import not found.");
    try {
      await cancelImport(env, importId);
      return json({ ok: true });
    } catch (error) {
      const code = error instanceof Error ? error.message : "import_cannot_cancel";
      return apiError(code === "import_not_found" ? 404 : 409, code, "The import cannot be cancelled now.");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/capture/credentials") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = captureCredentialInputSchema.safeParse(await readJson(request, 4 * 1024));
    } catch {
      return apiError(400, "invalid_capture_credential", "The connection could not be created.");
    }
    if (!parsed.success) {
      return apiError(400, "invalid_capture_credential", "Choose a connection type and name.");
    }
    return json(
      { ok: true, credential: await issueCaptureCredential(env.DB, parsed.data.kind, parsed.data.name) },
      { status: 201 },
    );
  }
  const captureCredentialMatch = /^\/api\/capture\/credentials\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "DELETE" && captureCredentialMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const id = captureCredentialMatch[1];
    if (id === undefined || !(await revokeCaptureCredential(env.DB, id))) {
      return apiError(404, "not_found", "Capture connection not found.");
    }
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/mcp/rotate") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const secret = await rotateMcpCredential(env.DB);
    return json({ ok: true, url: `${new URL(request.url).origin}/mcp/${secret}` });
  }

  if (request.method === "GET" && url.pathname === "/api/export") {
    return exportLibrary(env, url.searchParams.get("format") ?? "json");
  }

  const trashMatch = /^\/api\/bookmarks\/([0-9a-f-]+)\/(trash|restore)$/iu.exec(url.pathname);
  if (request.method === "POST" && trashMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const bookmarkId = trashMatch[1];
    if (bookmarkId === undefined) return apiError(404, "not_found", "Bookmark not found.");
    const bookmark = await setBookmarkDeleted(env.DB, bookmarkId, trashMatch[2] === "trash");
    return bookmark === null
      ? apiError(404, "not_found", "Bookmark not found.")
      : json({ ok: true, bookmark });
  }

  const permanentDeleteMatch = /^\/api\/bookmarks\/([0-9a-f-]+)\/delete$/iu.exec(url.pathname);
  if (request.method === "DELETE" && permanentDeleteMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const bookmarkId = permanentDeleteMatch[1];
    if (bookmarkId === undefined || !(await permanentlyDeleteBookmark(env, bookmarkId))) {
      return apiError(404, "not_found", "Trashed bookmark not found.");
    }
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/usage") {
    return json({
      ok: true,
      scope: "account-wide",
      source: "cloudflare-dashboard",
      recordedByLaterGator: false,
      dashboardUrl: "https://dash.cloudflare.com/",
      message:
        "Later Gator does not record OpenAI or Anthropic usage and does not present a local Workers AI estimate as account-wide usage.",
    });
  }

  const thumbnailMatch = /^\/api\/thumbnails\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "GET" && thumbnailMatch !== null) {
    const bookmarkId = thumbnailMatch[1];
    if (bookmarkId === undefined) return apiError(404, "not_found", "Thumbnail not found.");
    const thumbnail = await env.DB
      .prepare(
        `SELECT t.object_key, t.media_type, t.etag, t.byte_size
           FROM thumbnails t
           JOIN bookmarks b ON b.id = t.bookmark_id
          WHERE t.bookmark_id = ? AND t.state = 'ready' AND b.deleted_at IS NULL`,
      )
      .bind(bookmarkId)
      .first<{
        object_key: string;
        media_type: string;
        etag: string | null;
        byte_size: number;
      }>();
    if (thumbnail === null) return apiError(404, "not_found", "Thumbnail not found.");
    const headers = new Headers({
      "content-type": thumbnail.media_type,
      "cache-control": "private, max-age=3600",
      "content-length": thumbnail.byte_size.toString(),
      "x-content-type-options": "nosniff",
    });
    if (thumbnail.etag !== null) {
      headers.set("etag", thumbnail.etag);
      if (request.headers.get("if-none-match") === thumbnail.etag) {
        headers.delete("content-length");
        return new Response(null, { status: 304, headers });
      }
    }
    const object = await env.THUMBNAILS.get(thumbnail.object_key, {
      type: "arrayBuffer",
      cacheTtl: 3600,
    });
    if (object === null) return apiError(404, "not_found", "Thumbnail not found.");
    return new Response(object, { headers });
  }

  return apiError(404, "not_found", "Route not found.");
}

async function handleFetch(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/app.css") return appCss();
  if (request.method === "GET" && url.pathname === "/app.js") return appJs();
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "later-gator", architecture: "v6" });
  }
  if (request.method === "POST" && url.pathname === "/auth/login") return login(request, env);
  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/capture/")) {
    return capturePreflight();
  }
  if (request.method === "GET" && url.pathname === "/api/capture/options") {
    return captureOptions(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/capture/bookmarks") {
    return captureBookmark(request, env, "extension");
  }
  if (request.method === "POST" && url.pathname === "/api/capture/ios") {
    return captureBookmark(request, env, "ios");
  }
  const mcpMatch = /^\/mcp\/([^/]+)$/u.exec(url.pathname);
  if (
    mcpMatch !== null &&
    (request.method === "GET" || request.method === "POST" || request.method === "DELETE")
  ) {
    return handleMcp(request, env, context, mcpMatch[1] ?? "");
  }

  const session = await loadSession(request, env.DB);
  if (url.pathname === "/" && request.method === "GET") {
    if (session === null) return loginPage();
    return redirect(request, (await setupComplete(env.DB)) ? "/dashboard" : "/setup");
  }
  if (session === null) {
    if (url.pathname.startsWith("/api/")) {
      const response = apiError(401, "unauthenticated", "Sign in to Later Gator.");
      response.headers.append("set-cookie", expiredSessionCookie());
      response.headers.append(
        "set-cookie",
        "lg_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0",
      );
      return response;
    }
    const response = redirect(request, "/");
    response.headers.append("set-cookie", expiredSessionCookie());
    response.headers.append(
      "set-cookie",
      "lg_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0",
    );
    return response;
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    const context = { request, env, url, session };
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    await revokeSession(env.DB, session);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", expiredSessionCookie());
    headers.append("set-cookie", "lg_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0");
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname.startsWith("/api/")) {
    return handleAuthenticatedApi({ request, env, url, session });
  }
  if (request.method === "GET" && url.pathname === "/setup") {
    return (await setupComplete(env.DB)) ? redirect(request, "/settings") : setupPage();
  }
  if (request.method === "GET" && url.pathname === "/dashboard") {
    return (await setupComplete(env.DB)) ? dashboardPage() : redirect(request, "/setup");
  }
  if (request.method === "GET" && url.pathname === "/settings") {
    return (await setupComplete(env.DB)) ? settingsPage() : redirect(request, "/setup");
  }
  if (request.method === "GET" && url.pathname === "/extension/chrome") {
    return installationGuide("chrome");
  }
  if (request.method === "GET" && url.pathname === "/extension/firefox") {
    return installationGuide("firefox");
  }
  if (request.method === "GET" && url.pathname === "/shortcut/ios") {
    return installationGuide("ios");
  }
  return new Response("Not found", { status: 404 });
}

async function handleQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = backgroundMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }

    try {
      if ("type" in parsed.data && parsed.data.type === "import") {
        await processImportWork(env, parsed.data.importId);
        message.ack();
        continue;
      }
      if ("type" in parsed.data && parsed.data.type === "import_thumbnails") {
        await processImportThumbnailWork(env, parsed.data.importId);
        message.ack();
        continue;
      }
      if ("type" in parsed.data && parsed.data.type === "reset_storage") {
        await processResetStorage(env);
        message.ack();
        continue;
      }
      if ("type" in parsed.data && parsed.data.type === "dispatch_pending") {
        if (await importIsActive(env.DB)) {
          message.ack();
          continue;
        }
        const jobs = await env.DB
          .prepare(
            `SELECT id
               FROM background_jobs
              WHERE state = 'pending_dispatch'
              ORDER BY created_at
              LIMIT 20`,
          )
          .all<{ id: string }>();
        for (const job of jobs.results) {
          if (!(await dispatchJob(env.DB, env.BACKGROUND_QUEUE, job.id))) {
            throw new Error("queue_dispatch_failed");
          }
        }
        if (jobs.results.length === 20) {
          await env.BACKGROUND_QUEUE.send({ version: 1, type: "dispatch_pending" });
        }
        message.ack();
        continue;
      }
      const outcome = await organizeBookmarkJob(env, parsed.data.jobId);
      if (outcome === "retry") message.retry({ delaySeconds: 300 });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

const worker: ExportedHandler<Env> = {
  fetch(request, env, context) {
    return handleFetch(request, env, context);
  },
  queue(batch, env) {
    return handleQueue(batch, env);
  },
};

export default worker;
