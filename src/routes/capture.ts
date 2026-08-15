import { z } from "zod";
import {
  createBookmark,
  relateBookmarks,
} from "../adapters/library-repository";
import {
  authenticateCapture,
  type CaptureKind,
} from "../security/capture-credentials";
import { setThumbnailCandidate } from "../application/thumbnail-jobs";
import { dispatchJob, dispatchThumbnailJob } from "../application/queue-dispatch";
import { apiError, json, readJson } from "./responses";
import { sha256Base64 } from "../security/encoding";
import { normalizeBookmarkUrl } from "../domain/url";
import { notifyLibraryChanged } from "../adapters/library-events";
import { resolveRedirectTarget } from "../adapters/safe-remote";
import { isXInternalUrl } from "../application/page-content";
import { linkXPostDestinations } from "../application/organize-bookmark";

const extensionCaptureSchema = z.strictObject({
  requestId: z.uuid(),
  url: z.string().trim().min(1).max(8192),
  linkedUrl: z.string().trim().min(1).max(8192).nullable().optional(),
  title: z.string().trim().max(1000).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  note: z.string().trim().max(10_000).nullable().optional(),
  folderId: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  favorite: z.boolean().optional(),
  thumbnailUrl: z.string().trim().min(1).max(8192).nullable().optional(),
  /**
   * Shortened links read out of an X post's rendered body. They arrive
   * unresolved because only the Worker can follow a t.co address, and the
   * Worker is also what decides which of them lead anywhere worth keeping.
   */
  postLinks: z.array(z.string().trim().min(1).max(8192)).max(4).optional(),
});

/**
 * requestId is optional because the shared URL is already the idempotency key:
 * `bookmarks_active_normalized_url_unique` makes an active bookmark unique per
 * normalized URL, so a repeated share returns `already_saved` either way. A
 * client with no convenient way to produce a UUID — an Apple Shortcut, for
 * instance — can omit it and still behave idempotently.
 */
const iosCaptureSchema = z.strictObject({
  requestId: z.uuid().optional(),
  url: z.string().trim().min(1).max(8192),
});

const captureBookmarkSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
});

const captureBookmarkStatusSchema = z.strictObject({
  url: z.string().trim().min(1).max(8192),
});

/** Matches the cap organization already applies to links found in a post. */
const MAX_POST_LINKS = 2;

/**
 * Turns the shortened links out of an X post into destinations worth bookmarking.
 *
 * A post's own photo is published as a t.co link exactly like an outbound one,
 * so the two are indistinguishable until followed; resolving is what separates
 * them, and anything landing back inside X is dropped. A link that cannot be
 * resolved is skipped rather than saved as a t.co address, which would bookmark
 * the shortener instead of the page.
 */
async function resolvePostLinks(shortened: string[]): Promise<string[]> {
  const destinations: string[] = [];
  for (const link of shortened) {
    if (destinations.length >= MAX_POST_LINKS) break;
    const target = await resolveRedirectTarget(link).catch(() => null);
    if (target === null || isXInternalUrl(target)) continue;
    if (!destinations.includes(target)) destinations.push(target);
  }
  return destinations;
}

/** Adds the capture API CORS headers to a response. */
function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Answers capture CORS preflight with the allowed methods and headers. */
export function capturePreflight(): Response {
  return cors(new Response(null, { status: 204 }));
}

/** Replays a matching capture response or rejects a reused conflicting key. */
async function storedIdempotentResponse(
  db: D1Database,
  credentialId: string,
  requestId: string,
  requestHash: string,
): Promise<Response | null> {
  const row = await db
    .prepare(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_records
        WHERE scope = ? AND idempotency_key = ? AND expires_at > ?`,
    )
    .bind(`capture:${credentialId}`, requestId, new Date().toISOString())
    .first<{ request_hash: string; response_status: number; response_body: string }>();
  if (row !== null && row.request_hash !== requestHash) {
    return cors(
      apiError(
        409,
        "idempotency_conflict",
        "This request identifier was already used for different bookmark data.",
      ),
    );
  }
  return row === null
    ? null
    : cors(
        new Response(row.response_body, {
          status: row.response_status,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
}

/** Persists a bounded capture response before returning it with CORS headers. */
async function saveIdempotentResponse(
  db: D1Database,
  credentialId: string,
  requestId: string,
  requestHash: string,
  response: Response,
): Promise<Response> {
  const body = await response.clone().text();
  const now = new Date();
  await db
    .prepare(
      `INSERT OR REPLACE INTO idempotency_records (
        scope, idempotency_key, request_hash, response_status, response_body,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `capture:${credentialId}`,
      requestId,
      requestHash,
      response.status,
      body,
      now.toISOString(),
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    )
    .run();
  return cors(response);
}

/** Returns folders and tags available to an authenticated extension. */
export async function captureOptions(request: Request, env: Env): Promise<Response> {
  const credential = await authenticateCapture(request, env.DB, "capture:options");
  if (credential === null) return cors(apiError(401, "capture_unauthorized", "Reconnect Later Gator."));
  const [folders, tags] = await Promise.all([
    env.DB
      .prepare(
        `SELECT id, name, slug, kind
           FROM folders
          WHERE slug NOT IN ('imports')
          ORDER BY sort_order`,
      )
      .all(),
    env.DB
      .prepare(
        `SELECT id, display_name, normalized_name, usage_count
           FROM tags
          WHERE status = 'active'
          ORDER BY usage_count DESC, display_name
          LIMIT 500`,
      )
      .all(),
  ]);
  return cors(json({ ok: true, folders: folders.results, tags: tags.results }));
}

/** Searches live bookmarks for the extension relationship picker. */
export async function captureBookmarkSearch(request: Request, env: Env): Promise<Response> {
  const credential = await authenticateCapture(request, env.DB, "capture:bookmark-search");
  if (credential === null) return cors(apiError(401, "capture_unauthorized", "Reconnect Later Gator."));
  let parsed;
  try {
    parsed = captureBookmarkSearchSchema.safeParse(await readJson(request, 4 * 1024));
  } catch {
    return cors(apiError(400, "invalid_capture_search", "Enter a bookmark search."));
  }
  if (!parsed.success) {
    return cors(apiError(400, "invalid_capture_search", "Enter a bookmark search."));
  }
  const query = parsed.data.query.toLocaleLowerCase("en-US");
  const rows = await env.DB
    .prepare(
      `SELECT b.id, b.title, b.url, b.hostname, f.name AS folder_name
         FROM bookmarks b
         JOIN folders f ON f.id = b.folder_id
        WHERE b.deleted_at IS NULL
          AND (
            INSTR(LOWER(b.title), ?) > 0
            OR INSTR(LOWER(b.hostname), ?) > 0
            OR INSTR(LOWER(b.url), ?) > 0
          )
        ORDER BY CASE
                   WHEN INSTR(LOWER(b.title), ?) = 1 THEN 0
                   WHEN INSTR(LOWER(b.hostname), ?) = 1 THEN 1
                   ELSE 2
                 END,
                 b.modified_at DESC,
                 b.id
        LIMIT 12`,
    )
    .bind(query, query, query, query, query)
    .all();
  return cors(json({ ok: true, bookmarks: rows.results }));
}

/** Reports whether the extension's active page is already saved. */
export async function captureBookmarkStatus(request: Request, env: Env): Promise<Response> {
  const credential = await authenticateCapture(request, env.DB, "capture:options");
  if (credential === null) return cors(apiError(401, "capture_unauthorized", "Reconnect Later Gator."));
  let parsed;
  try {
    parsed = captureBookmarkStatusSchema.safeParse(await readJson(request, 12 * 1024));
  } catch {
    return cors(apiError(400, "invalid_capture_status", "The current page URL could not be read."));
  }
  if (!parsed.success) {
    return cors(apiError(400, "invalid_capture_status", "The current page URL could not be read."));
  }
  try {
    const normalized = normalizeBookmarkUrl(parsed.data.url);
    const bookmark = await env.DB
      .prepare(
        `SELECT 1
           FROM bookmarks
          WHERE normalized_url = ? AND deleted_at IS NULL
          LIMIT 1`,
      )
      .bind(normalized.normalizedUrl)
      .first();
    return cors(json({ ok: true, saved: bookmark !== null }));
  } catch {
    return cors(apiError(400, "invalid_capture_status", "The current page URL could not be read."));
  }
}

/** Validates and saves one idempotent extension or iOS capture request. */
export async function captureBookmark(
  request: Request,
  env: Env,
  kind: CaptureKind,
): Promise<Response> {
  const requiredScope = kind === "ios" ? "capture:create:minimal" : "capture:create";
  const credential = await authenticateCapture(request, env.DB, requiredScope);
  if (credential === null) return cors(apiError(401, "capture_unauthorized", "Reconnect Later Gator."));
  let payload: unknown;
  try {
    payload = await readJson(request, 64 * 1024);
  } catch {
    return cors(apiError(400, "invalid_capture", "The shared bookmark could not be read."));
  }
  const iosData = kind === "ios" ? iosCaptureSchema.safeParse(payload) : null;
  const extensionData = kind === "extension" ? extensionCaptureSchema.safeParse(payload) : null;
  if (
    (kind === "ios" && iosData?.success !== true) ||
    (kind === "extension" && extensionData?.success !== true)
  ) {
    return cors(apiError(400, "invalid_capture", "Check the shared URL and try again."));
  }
  const data =
    kind === "ios"
      ? (iosData?.success === true ? iosData.data : null)
      : (extensionData?.success === true ? extensionData.data : null);
  if (data === null) return cors(apiError(400, "invalid_capture", "Check the shared URL."));
  const requestHash = await sha256Base64(JSON.stringify(data));
  const idempotencyKey = data.requestId ?? null;
  /** Without a key there is no stored response to replay or conflict with. */
  const finish = async (response: Response): Promise<Response> =>
    idempotencyKey === null
      ? cors(response)
      : saveIdempotentResponse(env.DB, credential.id, idempotencyKey, requestHash, response);
  const repeated =
    idempotencyKey === null
      ? null
      : await storedIdempotentResponse(env.DB, credential.id, idempotencyKey, requestHash);
  if (repeated !== null) return repeated;
  try {
    const extensionFolderId =
      extensionData?.success === true
        ? extensionData.data.folderId ?? "folder_unsorted"
        : "folder_unsorted";
    const extensionAllowsManualOrganization = extensionFolderId !== "folder_unsorted";
    const sourceInput =
      kind === "ios"
        ? {
            url: data.url,
            folderId: "folder_unsorted",
            organizationPolicy: "full" as const,
          }
        : {
            url: data.url,
            title: extensionData?.success === true ? extensionData.data.title : null,
            description: extensionData?.success === true ? extensionData.data.description : null,
            note: extensionData?.success === true ? extensionData.data.note : null,
            folderId: extensionFolderId,
            tags:
              extensionData?.success === true && extensionAllowsManualOrganization
                ? extensionData.data.tags
                : [],
            favorite: extensionData?.success === true ? extensionData.data.favorite : false,
            organizationPolicy:
              extensionData?.success !== true ||
              extensionData.data.folderId === undefined ||
              extensionData.data.folderId === "folder_unsorted"
                ? ("full" as const)
                : ("none" as const),
          };
    const source = await createBookmark(env.DB, sourceInput, kind === "ios" ? "ios" : "extension");
    let linked = false;
    let linkFailed = false;
    const linkedUrl =
      extensionData?.success === true && extensionAllowsManualOrganization
        ? extensionData.data.linkedUrl
        : null;
    const linkedJobs: string[] = [];
    const thumbnailJobs: string[] =
      source.thumbnailJobId === null ? [] : [source.thumbnailJobId];
    if (linkedUrl !== null && linkedUrl !== undefined) {
      try {
        const linkedBookmark = await createBookmark(
          env.DB,
          { url: linkedUrl, folderId: "folder_unsorted", organizationPolicy: "full" },
          "linked",
        );
        linked = await relateBookmarks(env.DB, source.bookmark.id, linkedBookmark.bookmark.id);
        if (linkedBookmark.jobId !== null) linkedJobs.push(linkedBookmark.jobId);
        if (linkedBookmark.thumbnailJobId !== null) {
          thumbnailJobs.push(linkedBookmark.thumbnailJobId);
        }
      } catch {
        linkFailed = true;
      }
    }
    if (
      kind === "extension" &&
      source.created &&
      source.thumbnailJobId !== null &&
      extensionData?.success === true &&
      extensionData.data.thumbnailUrl !== null &&
      extensionData.data.thumbnailUrl !== undefined
    ) {
      await setThumbnailCandidate(
        env.DB,
        source.thumbnailJobId,
        extensionData.data.thumbnailUrl,
      );
    }
    const jobs = [...(source.jobId === null ? [] : [source.jobId]), ...linkedJobs];
    const dispatches = await Promise.all(
      jobs.map((jobId) => dispatchJob(env.DB, env.BACKGROUND_QUEUE, jobId)),
    );
    await Promise.all(
      thumbnailJobs.map(jobId =>
        dispatchThumbnailJob(env.DB, env.THUMBNAIL_QUEUE, jobId)),
    );
    /*
     * Links the post itself points at. X truncates long posts everywhere it
     * publishes them, so for those the extension reading the rendered page is
     * the only way this URL is ever seen; for short posts organization finds
     * the same links from oEmbed and this simply agrees with it, since both
     * ends deduplicate by normalized URL.
     */
    /*
     * Deliberately not conditional on the bookmark being new.
     *
     * A post is very often saved before its author adds the link, or saved
     * again once they have; on every save after the first the bookmark already
     * exists, and gating this on creation meant those saves silently did
     * nothing — the one case where re-saving is the natural way to pick the
     * link up was the case that could not. Linking is idempotent: an existing
     * destination is matched by normalized URL and the relationship has a
     * uniqueness constraint, so repeating it changes nothing.
     */
    if (kind === "extension" && extensionData?.success === true) {
      const destinations = await resolvePostLinks(extensionData.data.postLinks ?? []);
      if (destinations.length > 0) {
        await linkXPostDestinations(env, source.bookmark.id, destinations);
      }
    }
    // A bookmark saved from the extension or the Share Sheet lands with no
    // involvement from the dashboard, so an open tab is out of date the moment
    // this returns.
    if (source.created) await notifyLibraryChanged(env);
    const automationPending = dispatches.some((result) => !result);
    const result = linkFailed
      ? "source_saved_link_failed"
      : linked
        ? "saved_and_linked"
        : source.created
          ? "saved"
          : "already_saved";
    return await finish(
      json(
        {
          ok: true,
          result,
          bookmarkId: source.bookmark.id,
          automation: automationPending ? "pending" : jobs.length === 0 ? "not_requested" : "queued",
        },
        { status: source.created ? 201 : 200 },
      ),
    );
  } catch {
    return await finish(apiError(503, "capture_unavailable", "Failed to save to Later Gator."));
  }
}
