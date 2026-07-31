import { boundedBytes, safeFetch } from "../adapters/safe-remote";
import { sha256Base64 } from "../security/encoding";

const MAX_REMOTE_BYTES = 5 * 1024 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_STORED_BYTES = 500 * 1024;
const MAX_PREVIEW_WIDTH = 960;
const MAX_PREVIEW_HEIGHT = 1600;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type ThumbnailSource =
  | "import_cover"
  | "page_metadata"
  | "screenshot"
  | "favicon"
  | "user";

export interface PreviewDimensions {
  width: number;
  height: number;
}

export function calculatePreviewDimensions(
  sourceWidth: number,
  sourceHeight: number,
): PreviewDimensions {
  const scale = Math.min(
    1,
    MAX_PREVIEW_WIDTH / sourceWidth,
    MAX_PREVIEW_HEIGHT / sourceHeight,
  );
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function hasSupportedImageSignature(bytes: Uint8Array<ArrayBuffer>): boolean {
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...bytes.slice(start, end));
  return (
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a) ||
    ascii(0, 4) === "GIF8" ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    (ascii(4, 8) === "ftyp" &&
      ["avif", "avis", "mif1"].includes(ascii(8, 12)))
  );
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
    if (!response.ok || mediaType === undefined || !SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      return false;
    }
    const inputBytes = await boundedBytes(response, MAX_REMOTE_BYTES);
    if (!hasSupportedImageSignature(inputBytes)) return false;
    const info = await env.IMAGES.info(
      new Blob([inputBytes], { type: mediaType }).stream(),
    );
    if (!("width" in info) || info.width <= 0 || info.height <= 0) return false;

    const dimensions = calculatePreviewDimensions(info.width, info.height);
    let outputBytes: Uint8Array<ArrayBuffer> | null = null;
    for (const quality of [78, 60]) {
      const transformed = await env.IMAGES
        .input(new Blob([inputBytes], { type: mediaType }).stream())
        .transform({
          width: dimensions.width,
          height: dimensions.height,
          fit: "scale-down",
        })
        .output({ format: "image/webp", quality });
      try {
        outputBytes = await boundedBytes(transformed.response(), MAX_STORED_BYTES);
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "remote_content_too_large") {
          throw error;
        }
      }
    }
    if (outputBytes === null) return false;
    if (outputBytes.byteLength === 0) return false;

    const thumbnailId = crypto.randomUUID();
    const objectKey = `thumbnails/${bookmarkId}/${thumbnailId}.webp`;
    const old = await env.DB
      .prepare("SELECT object_key FROM thumbnails WHERE bookmark_id = ?")
      .bind(bookmarkId)
      .first<{ object_key: string }>();
    const now = new Date().toISOString();
    const sourceHash = await sha256Base64(candidateUrl);
    const etag = `"sha256-${await sha256Base64(outputBytes)}"`;
    await env.THUMBNAILS.put(objectKey, outputBytes);
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO thumbnails (
              id, bookmark_id, object_key, media_type, width, height, byte_size,
              source_type, source_url_hash, etag, state, created_at, updated_at
            ) VALUES (?, ?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
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
            dimensions.width,
            dimensions.height,
            outputBytes.byteLength,
            source,
            sourceHash,
            etag,
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
    } catch (error) {
      await env.THUMBNAILS.delete(objectKey);
      throw error;
    }
    if (old !== null && old.object_key !== objectKey) await env.THUMBNAILS.delete(old.object_key);
    return true;
  } catch {
    return false;
  }
}
