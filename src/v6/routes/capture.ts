import { z } from "zod";
import { importHoldsLibrary } from "../domain/import-state";
import {
  createBookmark,
  dispatchJob,
  relateBookmarks,
} from "../adapters/library-repository";
import {
  authenticateCapture,
  type CaptureKind,
} from "../security/capture-credentials";
import { dispatchThumbnailJob, setThumbnailCandidate } from "../application/thumbnail-jobs";
import { apiError, json, readJson } from "./responses";
import { sha256Base64 } from "../security/encoding";
import { normalizeBookmarkUrl } from "../domain/url";

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

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function capturePreflight(): Response {
  return cors(new Response(null, { status: 204 }));
}

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
  if (await importHoldsLibrary(env.DB)) {
    return cors(
      apiError(
        409,
        "import_in_progress",
        "The library is read-only until the active import finishes.",
      ),
    );
  }

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
