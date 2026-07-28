import { sha256Base64 } from "../security/encoding";

const MAX_REMOTE_BYTES = 5 * 1024 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_STORED_BYTES = 150 * 1024;

type ThumbnailSource =
  | "import_cover"
  | "page_metadata"
  | "screenshot"
  | "favicon"
  | "user";

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0"
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function safeRemoteUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    isBlockedHostname(url.hostname)
  ) {
    throw new Error("unsafe_remote_url");
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new Error("unsafe_remote_url");
  }
  return url;
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) throw new Error("remote_content_too_large");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > maximum) throw new Error("remote_content_too_large");
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function safeFetch(raw: string, accept: string): Promise<Response> {
  let target = safeRemoteUrl(raw);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(target, {
      redirect: "manual",
      headers: {
        accept,
        "user-agent": "LaterGator/6.0 thumbnail fetcher",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (location === null) throw new Error("remote_redirect_missing");
    target = safeRemoteUrl(new URL(location, target).toString());
  }
  throw new Error("remote_redirect_limit");
}

function metadataImage(html: string, pageUrl: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/iu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/iu,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/iu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1] !== undefined) {
      return new URL(match[1].replaceAll("&amp;", "&"), pageUrl).toString();
    }
  }
  return null;
}

export async function findPageThumbnail(pageUrl: string): Promise<string | null> {
  const response = await safeFetch(pageUrl, "text/html,application/xhtml+xml");
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
  const bytes = await boundedBytes(response, MAX_HTML_BYTES);
  return metadataImage(new TextDecoder().decode(bytes), pageUrl);
}

export async function ingestThumbnailCandidate(
  env: Env,
  bookmarkId: string,
  candidateUrl: string,
  source: ThumbnailSource,
): Promise<boolean> {
  try {
    const response = await safeFetch(candidateUrl, "image/avif,image/webp,image/*");
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!response.ok || !mediaType?.startsWith("image/")) return false;
    const inputBytes = await boundedBytes(response, MAX_REMOTE_BYTES);
    const info = await env.IMAGES.info(
      new Blob([inputBytes], { type: mediaType }).stream(),
    );
    if (!("width" in info) || info.width <= 0 || info.height <= 0) return false;

    const transformed = await env.IMAGES
      .input(new Blob([inputBytes], { type: mediaType }).stream())
      .transform({ width: 640, height: 360, fit: "cover", gravity: "entropy" })
      .output({ format: "image/webp", quality: 75 });
    const outputResponse = transformed.response();
    const outputBytes = await boundedBytes(outputResponse, MAX_STORED_BYTES);
    if (outputBytes.byteLength === 0) return false;

    const thumbnailId = crypto.randomUUID();
    const objectKey = `thumbnails/${bookmarkId}/${thumbnailId}.webp`;
    const object = await env.THUMBNAILS.put(objectKey, outputBytes, {
      httpMetadata: { contentType: "image/webp", cacheControl: "private, max-age=31536000" },
    });
    const old = await env.DB
      .prepare("SELECT object_key FROM thumbnails WHERE bookmark_id = ?")
      .bind(bookmarkId)
      .first<{ object_key: string }>();
    const now = new Date().toISOString();
    const sourceHash = await sha256Base64(candidateUrl);
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO thumbnails (
            id, bookmark_id, object_key, media_type, width, height, byte_size,
            source_type, source_url_hash, etag, state, created_at, updated_at
          ) VALUES (?, ?, ?, 'image/webp', 640, 360, ?, ?, ?, ?, 'ready', ?, ?)
          ON CONFLICT(bookmark_id) DO UPDATE SET
            id = excluded.id,
            object_key = excluded.object_key,
            media_type = excluded.media_type,
            width = excluded.width,
            height = excluded.height,
            byte_size = excluded.byte_size,
            source_type = excluded.source_type,
            source_url_hash = excluded.source_url_hash,
            etag = excluded.etag,
            state = excluded.state,
            updated_at = excluded.updated_at`,
        )
        .bind(
          thumbnailId,
          bookmarkId,
          objectKey,
          outputBytes.byteLength,
          source,
          sourceHash,
          object.httpEtag,
          now,
          now,
        ),
      env.DB
        .prepare(
          `UPDATE bookmarks
              SET thumbnail_id = ?, revision = revision + 1, modified_at = ?
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(thumbnailId, now, bookmarkId),
      env.DB
        .prepare(
          `UPDATE background_jobs
              SET expected_revision = expected_revision + 1, updated_at = ?
            WHERE bookmark_id = ?
              AND state IN (
                'pending_dispatch', 'queued', 'waiting_provider', 'paused_edit', 'paused_owner'
              )`,
        )
        .bind(now, bookmarkId),
    ]);
    if (old !== null && old.object_key !== objectKey) await env.THUMBNAILS.delete(old.object_key);
    return true;
  } catch {
    return false;
  }
}
