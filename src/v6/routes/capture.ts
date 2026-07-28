import { z } from "zod";
import {
  createBookmark,
  dispatchJob,
  relateBookmarks,
} from "../adapters/library-repository";
import {
  authenticateCapture,
  type CaptureKind,
} from "../security/capture-credentials";
import { ingestThumbnailCandidate } from "../application/thumbnails";
import { apiError, json, readJson } from "./responses";
import { sha256Base64 } from "../security/encoding";

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

const iosCaptureSchema = z.strictObject({
  requestId: z.uuid(),
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
  const repeated = await storedIdempotentResponse(
    env.DB,
    credential.id,
    data.requestId,
    requestHash,
  );
  if (repeated !== null) return repeated;

  try {
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
            folderId:
              extensionData?.success === true
                ? extensionData.data.folderId ?? "folder_unsorted"
                : "folder_unsorted",
            tags: extensionData?.success === true ? extensionData.data.tags : [],
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
    const linkedUrl = extensionData?.success === true ? extensionData.data.linkedUrl : null;
    const linkedJobs: string[] = [];
    if (linkedUrl !== null && linkedUrl !== undefined) {
      try {
        const linkedBookmark = await createBookmark(
          env.DB,
          { url: linkedUrl, folderId: "folder_unsorted", organizationPolicy: "full" },
          "linked",
        );
        linked = await relateBookmarks(env.DB, source.bookmark.id, linkedBookmark.bookmark.id);
        if (linkedBookmark.jobId !== null) linkedJobs.push(linkedBookmark.jobId);
      } catch {
        linkFailed = true;
      }
    }
    if (
      kind === "extension" &&
      source.created &&
      extensionData?.success === true &&
      extensionData.data.thumbnailUrl !== null &&
      extensionData.data.thumbnailUrl !== undefined
    ) {
      await ingestThumbnailCandidate(
        env,
        source.bookmark.id,
        extensionData.data.thumbnailUrl,
        "page_metadata",
      );
    }
    const jobs = [...(source.jobId === null ? [] : [source.jobId]), ...linkedJobs];
    const dispatches = await Promise.all(
      jobs.map((jobId) => dispatchJob(env.DB, env.BACKGROUND_QUEUE, jobId)),
    );
    const automationPending = dispatches.some((result) => !result);
    const result = linkFailed
      ? "source_saved_link_failed"
      : linked
        ? "saved_and_linked"
        : source.created
          ? "saved"
          : "already_saved";
    return await saveIdempotentResponse(
      env.DB,
      credential.id,
      data.requestId,
      requestHash,
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
    return await saveIdempotentResponse(
      env.DB,
      credential.id,
      data.requestId,
      requestHash,
      apiError(503, "capture_unavailable", "Failed to save to Later Gator."),
    );
  }
}
