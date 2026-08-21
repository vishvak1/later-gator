import {
  backgroundMessageSchema,
  thumbnailMessageSchema,
  automationPauseInputSchema,
  bookmarkListQuerySchema,
  completeSetupInputSchema,
  captureCredentialInputSchema,
  createBookmarkInputSchema,
  createTagInputSchema,
  providerActivationInputSchema,
  providerCandidateInputSchema,
  resetApplicationInputSchema,
  relationshipInputSchema,
  thumbnailReclaimInputSchema,
  updatePersonalInstructionsInputSchema,
  updateBookmarkInputSchema,
} from "./domain/schemas";
import {
  completeSetup,
  createTag,
  createBookmark,
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
  updatePersonalInstructions,
} from "./adapters/library-repository";
import {
  dashboardPage,
  loginPage,
  settingsPage,
  setupPage,
  themeFromCookie,
} from "./routes/pages";
import { apiError, json, readJson, redirect } from "./routes/responses";
import {
  csrfCookie,
  expiredCsrfCookie,
  expiredSessionCookie,
  loadSession,
  originMatches,
  requireCsrf,
  revokeSession,
  type DashboardSession,
} from "./security/sessions";
import {
  beginOwnerLogin,
  completeOwnerLogin,
  OwnerLoginError,
} from "./security/owner-auth";
import { organizeBookmarkJob } from "./application/organize-bookmark";
import { getImportStatus, startRaindropCsvImport } from "./application/imports";
import {
  processResetStorage,
  resetApplication,
} from "./application/reset";
import { ingestThumbnailCandidate } from "./application/thumbnails";
import {
  runtimeThumbnailBindings,
  thumbnailStore,
  ThumbnailStorageFailure,
} from "./adapters/thumbnail-store";
import {
  approveThumbnailMigrationCleanup,
  disableThumbnailStorage,
  enableKvThumbnailStorage,
  processThumbnailMigration,
  processThumbnailMigrationCleanup,
  reclaimOldThumbnails,
  runtimeThumbnailMigrationStores,
  startThumbnailMigration,
  thumbnailStorageSummary,
} from "./application/thumbnail-storage";
import {
  currentPublicCatalogState,
  refreshPublicCatalogs,
} from "./application/catalogs";
import {
  captureBookmark,
  captureBookmarkSearch,
  captureBookmarkStatus,
  captureOptions,
  capturePreflight,
} from "./routes/capture";
import {
  issueCaptureCredential,
  listExtensionDevices,
  revokeExtensionDevice,
  revokeCaptureCredential,
} from "./security/capture-credentials";
import { capturePairingExchange } from "./routes/capture-pairing";
import {
  deleteProviderCredential,
  saveProviderCredential,
} from "./security/credential-vault";
import {
  OrganizationProviderError,
  testProviderConnection,
} from "./adapters/organization-providers";
import {
  handleMcpOAuthRequest,
  listMcpConnections,
  revokeMcpConnection,
} from "./routes/mcp-oauth";
import { repairOrganizationBacklog } from "./application/automation";
import { processThumbnailJob, repairThumbnailBacklog } from "./application/thumbnail-jobs";
import { dispatchJob, dispatchThumbnailJob } from "./application/queue-dispatch";
import { ASSET_MANIFEST } from "./generated/asset-manifest";
import { providerStatusMessage } from "./domain/provider-status";
import { libraryEventsStub, notifyLibraryChanged } from "./adapters/library-events";
import {
  deleteBookmarkVectors,
  hasEmbedBacklog,
  processEmbedBacklog,
  semanticBookmarkIds,
} from "./application/embeddings";
import {
  getXDestinationReview,
  keepXDestinationReview,
  xDestinationDecisionSchema,
} from "./application/x-destination-review";

interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  session: DashboardSession;
  executionContext: ExecutionContext;
}

/**
 * A failed provider test previously said only that it failed, which gave no way
 * to tell a mistyped model from one that cannot produce structured output. The
 * wording now lives in one shared table so Settings, the test result and the
 * dashboard indicator all describe a condition the same way.
 */
function providerTestReason(safeCode: string): string {
  return providerStatusMessage(safeCode);
}

/** Sets up complete for Worker request and queue routing. */
async function setupComplete(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT setup_status FROM app_state WHERE id = 1")
    .first<{ setup_status: string }>();
  return row?.setup_status === "ready";
}

/** Completes an installation-bound owner login and returns to the runtime. */
async function ownerLoginCallback(request: Request, env: Env): Promise<Response> {
  try {
    const session = await completeOwnerLogin(request, env);
    const headers = new Headers({
      location: (await setupComplete(env.DB)) ? "/dashboard" : "/setup",
      "cache-control": "no-store",
    });
    headers.append("set-cookie", session.cookie);
    headers.append("set-cookie", csrfCookie(session.csrfToken));
    return new Response(null, { status: 303, headers });
  } catch (error) {
    console.error(JSON.stringify({
      event: "owner_login_failed",
      safeCode: error instanceof OwnerLoginError
        ? error.safeCode
        : "identity_provider_unavailable",
    }));
    return loginPage("unavailable", themeFromCookie(request));
  }
}

/** Enforces same-origin and CSRF checks for an authenticated mutation. */
async function requireMutationSecurity(context: RouteContext): Promise<Response | null> {
  if (!originMatches(context.request)) {
    return apiError(403, "origin_rejected", "Reload Later Gator and try again.");
  }
  if (!(await requireCsrf(context.request, context.env.DB, context.session))) {
    return apiError(403, "csrf_rejected", "Reload Later Gator and try again.");
  }
  return null;
}

/** Converts URL search parameters into the object consumed by Zod. */
function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

/** Escapes one value for a CSV export cell. */
function csvCell(value: unknown): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? value.toString()
      : "";
  return `"${text.replaceAll('"', '""')}"`;
}

/** Streams the active library as a JSON or CSV download. */
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
  return new Response(JSON.stringify({ version: "1.0.0", exportedAt: new Date().toISOString(), bookmarks: rows.results }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="later-gator-export.json"',
      "cache-control": "no-store",
    },
  });
}

/** Renders installation instructions for a capture surface. */
function installationGuide(kind: "chrome" | "ios"): Response {
  const copy =
    kind === "ios"
      ? `<h1>Install the iOS Share Sheet Shortcut</h1><ol><li>In Later Gator Settings, generate an iOS connection.</li><li>Create a Shortcut that accepts URLs from the Share Sheet.</li><li>Add “Get Contents of URL”: POST the shared URL and a generated UUID as JSON to the displayed endpoint.</li><li>Add the Authorization header as Bearer plus the displayed token.</li><li>If result is saved, show “Saved to Later Gator”; if already_saved, show “Already saved in Later Gator”; otherwise show “Failed to save to Later Gator”.</li></ol><p>The maintained request template is in <code>shortcuts/ios/request-template.json</code>.</p>`
      : `<h1>Install the Chrome extension</h1><ol><li>Download or clone the Later Gator repository.</li><li>Open Chrome's extensions page and enable Developer mode.</li><li>Load <code>extension/chrome</code> as an unpacked extension.</li><li>In Settings, generate and copy one browser-extension connection code.</li><li>Open the toolbar popup, paste the code, select Connect, and approve access only to this deployment host.</li></ol><p>The extension asks for the active tab only when you open it and does not request browsing history.</p>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Later Gator installation</title><link rel="stylesheet" href="${ASSET_MANIFEST.css}"></head><body><main class="settings-shell"><section class="panel">${copy}<p><a href="/settings">Back to Settings</a></p></section></main></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/** Handles authenticated api for Worker request and queue routing. */
async function handleAuthenticatedApi(context: RouteContext): Promise<Response> {
  const { request, env, url } = context;

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const organizationPending = await repairOrganizationBacklog(env);
    const thumbnailPending = await repairThumbnailBacklog(env);
    if (organizationPending) {
      await env.BACKGROUND_QUEUE.send({ type: "dispatch_pending" }).catch(() => undefined);
    }
    if (thumbnailPending) {
      await env.THUMBNAIL_QUEUE.send({
        type: "dispatch_thumbnail_pending",
      }).catch(() => undefined);
    }
    if (await hasEmbedBacklog(env).catch(() => false)) {
      await env.BACKGROUND_QUEUE.send({ type: "embed_pending" }).catch(() => undefined);
    }
    return json({ ok: true, state: await getBootstrapState(env.DB) });
  }

  if (request.method === "GET" && url.pathname === "/api/mcp/connections") {
    return json({
      ok: true,
      endpoint: `${url.origin}/mcp`,
      connections: await listMcpConnections(env, url.origin),
    });
  }

  const mcpConnectionMatch = /^\/api\/mcp\/connections\/([0-9a-f-]{36})$/u.exec(
    url.pathname,
  );
  if (request.method === "DELETE" && mcpConnectionMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const connectionId = mcpConnectionMatch[1];
    if (connectionId === undefined) {
      return apiError(404, "not_found", "AI connection not found.");
    }
    const revoked = await revokeMcpConnection(env, url.origin, connectionId);
    if (!revoked) return apiError(404, "not_found", "AI connection not found.");
    return json({ ok: true });
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
    await resetApplication(env, context.session.idHash, url.origin);
    return json({ ok: true, redirectTo: "/setup" });
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

  if (request.method === "PUT" && url.pathname === "/api/profile/personal-instructions") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = updatePersonalInstructionsInputSchema.safeParse(await readJson(request));
    } catch {
      return apiError(400, "invalid_json", "The personal instructions could not be read.");
    }
    if (!parsed.success) {
      return apiError(400, "invalid_personal_instructions", "Personal instructions must be 5,000 characters or fewer.");
    }
    await updatePersonalInstructions(env.DB, parsed.data.personalInstructions);
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/bookmarks") {
    const parsed = bookmarkListQuerySchema.safeParse(queryObject(url));
    if (!parsed.success) {
      return apiError(400, "invalid_filters", "One or more bookmark filters are invalid.");
    }
    try {
      const semanticIds =
        parsed.data.q !== undefined && parsed.data.q !== ""
          ? await semanticBookmarkIds(env, parsed.data.q)
          : null;
      const pageResult = await listBookmarkPage(env.DB, parsed.data, semanticIds);
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
      const thumbnailJobIds =
        created.thumbnailJobId === null ? [] : [created.thumbnailJobId];
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
        if (linked.thumbnailJobId !== null) thumbnailJobIds.push(linked.thumbnailJobId);
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
      await Promise.all(
        thumbnailJobIds.map(jobId =>
          dispatchThumbnailJob(env.DB, env.THUMBNAIL_QUEUE, jobId)),
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
      const organizationPending = await repairOrganizationBacklog(env);
      const thumbnailPending = await repairThumbnailBacklog(env);
      if (organizationPending) {
        await env.BACKGROUND_QUEUE.send({ type: "dispatch_pending" }).catch(() => undefined);
      }
      if (thumbnailPending) {
        await env.THUMBNAIL_QUEUE.send({
          type: "dispatch_thumbnail_pending",
        }).catch(() => undefined);
      }
      await env.BACKGROUND_QUEUE.send({ type: "embed_pending" }).catch(() => undefined);
      return json({ ok: true, bookmark: result });
    }
  }

  const xDestinationReviewMatch =
    /^\/api\/bookmarks\/([0-9a-f-]+)\/x-destination-review$/iu.exec(url.pathname);
  if (xDestinationReviewMatch !== null) {
    const bookmarkId = xDestinationReviewMatch[1];
    if (bookmarkId === undefined) return apiError(404, "not_found", "Review not found.");
    if (request.method === "GET") {
      const review = await getXDestinationReview(env.DB, bookmarkId);
      return review === null
        ? apiError(404, "not_found", "Review not found.")
        : json({ ok: true, review });
    }
    if (request.method === "POST") {
      const securityError = await requireMutationSecurity(context);
      if (securityError !== null) return securityError;
      let parsed;
      try {
        parsed = xDestinationDecisionSchema.safeParse(await readJson(request, 8 * 1024));
      } catch {
        return apiError(400, "invalid_x_destination_decision", "The selection could not be read.");
      }
      if (!parsed.success) {
        return apiError(400, "invalid_x_destination_decision", "Choose the links to connect.");
      }
      if (!(await keepXDestinationReview(env, bookmarkId, parsed.data.selectedReviewIds))) {
        return apiError(404, "not_found", "Review not found.");
      }
      await notifyLibraryChanged(env);
      return json({ ok: true });
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
      if (linked.thumbnailJobId !== null) {
        await dispatchThumbnailJob(env.DB, env.THUMBNAIL_QUEUE, linked.thumbnailJobId);
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

  if (request.method === "GET" && url.pathname === "/api/storage/thumbnails") {
    return json({ ok: true, storage: await thumbnailStorageSummary(env.DB) });
  }

  if (request.method === "GET" && url.pathname === "/api/catalogs") {
    return json({
      ok: true,
      catalogs: await currentPublicCatalogState(env.DB, env.CONTROL_PLANE_ORIGIN),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/catalogs/refresh") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    await refreshPublicCatalogs(env.DB, env.CONTROL_PLANE_ORIGIN);
    return json({
      ok: true,
      catalogs: await currentPublicCatalogState(env.DB, env.CONTROL_PLANE_ORIGIN),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/storage/thumbnails/disable") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    await disableThumbnailStorage(env.DB);
    return json({ ok: true, storage: await thumbnailStorageSummary(env.DB) });
  }

  if (request.method === "POST" && url.pathname === "/api/storage/thumbnails/enable-kv") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    await enableKvThumbnailStorage(env.DB);
    await env.THUMBNAIL_QUEUE.send({ type: "dispatch_thumbnail_pending" });
    return json({ ok: true, storage: await thumbnailStorageSummary(env.DB) });
  }

  if (request.method === "POST" && url.pathname === "/api/storage/thumbnails/reclaim") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    let parsed;
    try {
      parsed = thumbnailReclaimInputSchema.safeParse(await readJson(request, 4 * 1024));
    } catch {
      return apiError(400, "invalid_reclaim", "Choose how many thumbnails to remove.");
    }
    if (!parsed.success) {
      return apiError(400, "invalid_reclaim", "Choose how many thumbnails to remove.");
    }
    const reclaimed = await reclaimOldThumbnails(
      env.DB,
      runtimeThumbnailBindings(env),
      parsed.data.limit,
    );
    return json({ ok: true, reclaimed, storage: await thumbnailStorageSummary(env.DB) });
  }

  if (request.method === "POST" && url.pathname === "/api/storage/thumbnails/migrate-r2") {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    try {
      const migrationId = await startThumbnailMigration(
        env.DB,
        runtimeThumbnailMigrationStores(env),
      );
      await env.THUMBNAIL_QUEUE.send({
        type: "thumbnail_storage_migration",
        migrationId,
        action: "copy",
      });
      return json({ ok: true, migrationId }, { status: 202 });
    } catch (error: unknown) {
      const code = error instanceof ThumbnailStorageFailure
        ? error.code
        : "thumbnail_migration_unavailable";
      return apiError(
        409,
        code,
        "R2 must be authorized and bound before this migration can start.",
      );
    }
  }

  const thumbnailMigrationAction =
    /^\/api\/storage\/thumbnails\/migrations\/([0-9a-f-]{36})\/(approve-cleanup|resume)$/u
      .exec(url.pathname);
  if (request.method === "POST" && thumbnailMigrationAction !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const migrationId = thumbnailMigrationAction[1];
    const action = thumbnailMigrationAction[2];
    if (migrationId === undefined || action === undefined) {
      return apiError(404, "not_found", "Thumbnail migration not found.");
    }
    if (
      action === "approve-cleanup" &&
      !(await approveThumbnailMigrationCleanup(env.DB, migrationId))
    ) {
      return apiError(409, "cleanup_not_ready", "Verify the R2 copy before cleanup.");
    }
    await env.THUMBNAIL_QUEUE.send({
      type: "thumbnail_storage_migration",
      migrationId,
      action: action === "approve-cleanup" ? "cleanup" : "copy",
    });
    return json({ ok: true }, { status: 202 });
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
        parsed.data.provider,
        parsed.data.credential,
      );
    }
    const now = new Date().toISOString();
    try {
      const testGateway = await env.DB
        .prepare("SELECT ai_gateway_id FROM provider_settings WHERE id = 1")
        .first<{ ai_gateway_id: string | null }>();
      await testProviderConnection(
        env,
        parsed.data.provider,
        parsed.data.model,
        testGateway?.ai_gateway_id ?? null,
      );
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
      return apiError(422, safeCode, `${providerTestReason(safeCode)} The active provider was not changed.`);
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
              SET provider = ?, model = ?, ai_gateway_id = ?,
                  operational_status = 'ready', last_safe_error_code = NULL, updated_at = ?
            WHERE id = 1`,
        )
        .bind(
          parsed.data.provider,
          parsed.data.model,
          parsed.data.aiGatewayId === undefined || parsed.data.aiGatewayId === ""
            ? null
            : parsed.data.aiGatewayId,
          now,
        ),
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
              'pending_dispatch', 'queued', 'waiting_provider', 'paused_owner'
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
            WHERE ai_state IN ('pending', 'waiting_provider', 'paused_owner')`,
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

  if (request.method === "POST" && url.pathname === "/api/imports") {
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
      if (!(file instanceof File)) {
        return apiError(400, "invalid_import", "Choose a Raindrop CSV.");
      }
      if (option !== "reorganize" && option !== "preserve") {
        return apiError(400, "invalid_import_option", "Choose how imported tags and descriptions should be handled.");
      }
      const started = await startRaindropCsvImport(env, file, option);
      context.executionContext.waitUntil(started.completion);
      return json(
        { ok: true, import: started.status },
        { status: 202 },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_import";
      const status = code === "csv_too_large" || code === "csv_too_many_rows" ? 413 : 422;
      return apiError(status, code, "The Raindrop CSV could not be imported.");
    }
  }

  const importMatch = /^\/api\/imports\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "GET" && importMatch !== null) {
    const importId = importMatch[1];
    if (importId === undefined) return apiError(404, "not_found", "Import not found.");
    const status = await getImportStatus(env.DB, importId);
    return status === null ? apiError(404, "not_found", "Import not found.") : json({ ok: true, import: status });
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
  if (request.method === "GET" && url.pathname === "/api/capture/devices") {
    return json({ ok: true, devices: await listExtensionDevices(env.DB) });
  }
  const extensionDeviceMatch = /^\/api\/capture\/devices\/([A-Za-z0-9_-]{8,128})$/u
    .exec(url.pathname);
  if (request.method === "DELETE" && extensionDeviceMatch !== null) {
    const securityError = await requireMutationSecurity(context);
    if (securityError !== null) return securityError;
    const deviceId = extensionDeviceMatch[1];
    if (deviceId === undefined || !(await revokeExtensionDevice(env.DB, deviceId))) {
      return apiError(404, "not_found", "Extension device not found.");
    }
    return json({ ok: true });
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
    await deleteBookmarkVectors(env, [bookmarkId]).catch(() => undefined);
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

  const thumbnailMatch =
    /^\/api\/thumbnails\/([0-9a-f-]+)\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (request.method === "GET" && thumbnailMatch !== null) {
    const bookmarkId = thumbnailMatch[1];
    const thumbnailId = thumbnailMatch[2];
    if (bookmarkId === undefined || thumbnailId === undefined) {
      return apiError(404, "not_found", "Thumbnail not found.");
    }
    const thumbnail = await env.DB
      .prepare(
        `SELECT t.object_key, t.media_type, t.etag, t.byte_size, t.storage_backend
           FROM thumbnails t
           JOIN bookmarks b ON b.id = t.bookmark_id
          WHERE t.bookmark_id = ? AND t.id = ?
            AND t.state = 'ready' AND b.deleted_at IS NULL`,
      )
      .bind(bookmarkId, thumbnailId)
      .first<{
        object_key: string;
        media_type: string;
        etag: string | null;
        byte_size: number;
        storage_backend: "kv" | "r2";
      }>();
    if (thumbnail === null) return apiError(404, "not_found", "Thumbnail not found.");
    const headers = new Headers({
      "content-type": thumbnail.media_type,
      "cache-control": "private, max-age=31536000, immutable",
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
    const object = await thumbnailStore(
      thumbnail.storage_backend,
      runtimeThumbnailBindings(env),
    )
      .get(thumbnail.object_key);
    if (object === null) return apiError(404, "not_found", "Thumbnail not found.");
    return new Response(object, { headers });
  }

  return apiError(404, "not_found", "Route not found.");
}

/** Handles fetch for Worker request and queue routing. */
async function handleFetch(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    try {
      const release = await env.DB.prepare(
        `SELECT release, schema_version, health_contract_version
           FROM runtime_release_state WHERE id = 1`,
      ).first<{ release: string; schema_version: number; health_contract_version: number }>();
      if (release === null) {
        return json({
          contractVersion: 1,
          runtimeRelease: "1.0.0",
          schemaVersion: 0,
          status: "unavailable",
          bindingReadiness: "ready",
          queueReadiness: "ready",
          safeErrorCodes: ["migration_required"],
        }, { status: 503 });
      }
      return json({
        contractVersion: release.health_contract_version,
        runtimeRelease: release.release,
        schemaVersion: release.schema_version,
        status: "ready",
        bindingReadiness: "ready",
        queueReadiness: "ready",
        safeErrorCodes: [],
      });
    } catch {
      return json({
        contractVersion: 1,
        runtimeRelease: "1.0.0",
        schemaVersion: 0,
        status: "unavailable",
        bindingReadiness: "unavailable",
        queueReadiness: "unavailable",
        safeErrorCodes: ["database_unavailable"],
      }, { status: 503 });
    }
  }
  if (request.method === "GET" && url.pathname === "/auth/login") {
    try {
      return await beginOwnerLogin(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "owner_login_start_failed",
        safeCode: error instanceof OwnerLoginError
          ? error.safeCode
          : "identity_provider_unavailable",
      }));
      return loginPage("unavailable", themeFromCookie(request));
    }
  }
  if (request.method === "GET" && url.pathname === "/auth/callback") {
    return ownerLoginCallback(request, env);
  }
  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/capture/")) {
    return capturePreflight();
  }
  if (request.method === "GET" && url.pathname === "/api/capture/options") {
    return captureOptions(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/capture/bookmarks") {
    return captureBookmark(request, env, "extension");
  }
  if (request.method === "POST" && url.pathname === "/api/capture/bookmark-search") {
    return captureBookmarkSearch(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/capture/bookmark-status") {
    return captureBookmarkStatus(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/capture/ios") {
    return captureBookmark(request, env, "ios");
  }
  if (request.method === "POST" && url.pathname === "/api/capture/pair") {
    return capturePairingExchange(request, env);
  }
  if (
    url.pathname === "/mcp" ||
    url.pathname === "/authorize" ||
    url.pathname === "/oauth/token" ||
    url.pathname === "/oauth/register" ||
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname.startsWith("/.well-known/oauth-protected-resource")
  ) {
    return handleMcpOAuthRequest(request, env, context);
  }

  const session = await loadSession(request, env.DB);
  if (url.pathname === "/" && request.method === "GET") {
    if (session === null) return loginPage(null, themeFromCookie(request));
    return redirect(request, (await setupComplete(env.DB)) ? "/dashboard" : "/setup");
  }
  if (session === null) {
    if (url.pathname.startsWith("/api/")) {
      const response = apiError(401, "unauthenticated", "Sign in to Later Gator.");
      response.headers.append("set-cookie", expiredSessionCookie());
      response.headers.append("set-cookie", expiredCsrfCookie());
      return response;
    }
    const response = redirect(request, "/");
    response.headers.append("set-cookie", expiredSessionCookie());
    response.headers.append("set-cookie", expiredCsrfCookie());
    return response;
  }

  /*
   * The dashboard's live connection. It sits behind the session check like any
   * other authenticated route — the handshake carries the session cookie — so
   * the Durable Object itself never has to authenticate anyone.
   */
  if (request.method === "GET" && url.pathname === "/api/events") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return apiError(426, "websocket_required", "This endpoint expects a WebSocket.");
    }
    return libraryEventsStub(env).fetch("https://library-events/connect", request);
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    const routeContext = { request, env, url, session, executionContext: context };
    const securityError = await requireMutationSecurity(routeContext);
    if (securityError !== null) return securityError;
    await revokeSession(env.DB, session);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", expiredSessionCookie());
    headers.append("set-cookie", expiredCsrfCookie());
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname.startsWith("/api/")) {
    return handleAuthenticatedApi({ request, env, url, session, executionContext: context });
  }
  if (request.method === "GET" && url.pathname === "/setup") {
    return (await setupComplete(env.DB)) ? redirect(request, "/settings") : setupPage(themeFromCookie(request));
  }
  if (request.method === "GET" && url.pathname === "/dashboard") {
    return (await setupComplete(env.DB)) ? dashboardPage(themeFromCookie(request)) : redirect(request, "/setup");
  }
  if (request.method === "GET" && url.pathname === "/settings") {
    return (await setupComplete(env.DB)) ? settingsPage(themeFromCookie(request)) : redirect(request, "/setup");
  }
  if (request.method === "GET" && url.pathname === "/extension/chrome") {
    return installationGuide("chrome");
  }
  if (request.method === "GET" && url.pathname === "/shortcut/ios") {
    return installationGuide("ios");
  }
  return new Response("Not found", { status: 404 });
}

/** Handles queue for Worker request and queue routing. */
async function handleQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const thumbnailMessage = thumbnailMessageSchema.safeParse(message.body);
      if (thumbnailMessage.success) {
        if (thumbnailMessage.data.type === "thumbnail_storage_migration") {
          const stores = runtimeThumbnailMigrationStores(env);
          if (thumbnailMessage.data.action === "copy") {
            const outcome = await processThumbnailMigration(
              env.DB,
              stores,
              thumbnailMessage.data.migrationId,
            );
            if (outcome === "continued") {
              await env.THUMBNAIL_QUEUE.send(thumbnailMessage.data);
            }
          } else if (
            await processThumbnailMigrationCleanup(
              env.DB,
              stores,
              thumbnailMessage.data.migrationId,
            ) === "continued"
          ) {
            await env.THUMBNAIL_QUEUE.send(thumbnailMessage.data);
          }
          message.ack();
          continue;
        }
        if (thumbnailMessage.data.type === "dispatch_thumbnail_pending") {
          const jobs = await env.DB
            .prepare(
              `SELECT id
                 FROM thumbnail_jobs
                WHERE state = 'pending_dispatch'
                ORDER BY created_at
                LIMIT 20`,
            )
            .all<{ id: string }>();
          for (const job of jobs.results) {
            if (!(await dispatchThumbnailJob(env.DB, env.THUMBNAIL_QUEUE, job.id))) {
              throw new Error("thumbnail_queue_dispatch_failed");
            }
          }
          if (jobs.results.length === 20) {
            await env.THUMBNAIL_QUEUE.send({
              type: "dispatch_thumbnail_pending",
            });
          }
          message.ack();
          continue;
        }
        const outcome = await processThumbnailJob(env, thumbnailMessage.data.jobId);
        // A finished job is the moment a cover or a resolved title appears, so
        // it is the moment an open dashboard is out of date.
        if (outcome !== "retry") await notifyLibraryChanged(env);
        if (outcome === "retry") message.retry({ delaySeconds: 300 });
        else message.ack();
        continue;
      }

      const backgroundMessage = backgroundMessageSchema.safeParse(message.body);
      if (!backgroundMessage.success) {
        message.ack();
        continue;
      }
      if (backgroundMessage.data.type === "reset_storage") {
        await processResetStorage(env);
        message.ack();
        continue;
      }
      if (backgroundMessage.data.type === "embed_pending") {
        if (await processEmbedBacklog(env)) {
          await env.BACKGROUND_QUEUE.send({ type: "embed_pending" });
        }
        message.ack();
        continue;
      }
      if (backgroundMessage.data.type === "dispatch_pending") {
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
          await env.BACKGROUND_QUEUE.send({ type: "dispatch_pending" });
        }
        message.ack();
        continue;
      }
      const outcome = await organizeBookmarkJob(env, backgroundMessage.data.jobId);
      // This is the write the dashboard cannot see: AI has moved the bookmark
      // out of Unsorted and the sidebar counts in every open tab are now wrong.
      if (outcome !== "retry" && outcome !== "retry_soon") await notifyLibraryChanged(env);
      // 300s is provider back-off. A revision that moved mid-run needs no
      // back-off at all — it only needs running again against the new one.
      if (outcome === "retry_soon") message.retry({ delaySeconds: 5 });
      else if (outcome === "retry") message.retry({ delaySeconds: 300 });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

const worker: ExportedHandler<Env> = {
  /** Routes an incoming HTTP request through the Worker. */
  fetch(request, env, context) {
    return handleFetch(request, env, context);
  },
  /** Routes an incoming Queue batch through the Worker. */
  queue(batch, env) {
    return handleQueue(batch, env);
  },
};

export default worker;
