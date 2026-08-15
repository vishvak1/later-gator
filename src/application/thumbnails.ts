import { boundedBytes, boundedBytesTruncated, safeFetch } from "../adapters/safe-remote";
import { collapseWhitespace, decodeEntities } from "./page-content";
import { sha256Base64 } from "../security/encoding";

const MAX_REMOTE_BYTES = 5 * 1024 * 1024;
// Matches the page-content budget so cover discovery reaches the same og tags.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
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

/** Calculates preview dimensions for thumbnail discovery. */
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

/** Returns whether supported image signature for thumbnail discovery. */
function hasSupportedImageSignature(bytes: Uint8Array<ArrayBuffer>): boolean {
  /** Decodes a byte range as ASCII for image signature checks. */
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

/** Resolves the best Open Graph or social preview image declared by a page. */
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

/** Reads and HTML-decodes one attribute from a matched tag fragment. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(tag);
  return match?.[1] ?? null;
}

/** Collects declared page icons as lower-priority thumbnail candidates. */
function iconImages(html: string, pageUrl: string): string[] {
  const icons: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = attribute(tag, "rel")?.toLocaleLowerCase("en-US") ?? "";
    const href = attribute(tag, "href");
    if (href === null || !rel.split(/\s+/u).some(value => value.includes("icon"))) continue;
    try {
      icons.push(new URL(href.replaceAll("&amp;", "&"), pageUrl).toString());
    } catch {
      // Ignore malformed page metadata and continue to the conventional favicon.
    }
  }
  return icons;
}

/**
 * Site-wide default covers carry no information about the individual bookmark.
 * X serves this one from its own og:image whenever a post is reached by
 * client-side navigation, which would otherwise give every saved post the
 * same picture.
 */
const PLACEHOLDER_IMAGE_PATTERNS = [
  /^https?:\/\/abs\.twimg\.com\/rweb\/ssr\/default\//iu,
  /^https?:\/\/abs\.twimg\.com\/responsive-web\/[^/]*\/(?:icon|og)[^/]*$/iu,
];

/** Returns whether placeholder thumbnail for thumbnail discovery. */
export function isPlaceholderThumbnail(candidateUrl: string): boolean {
  return PLACEHOLDER_IMAGE_PATTERNS.some(pattern => pattern.test(candidateUrl));
}

export interface ThumbnailCandidate {
  url: string;
  source: "page_metadata" | "favicon";
}

/** What a single page fetch yields: the cover candidates and the page's title. */
export interface PageThumbnailScan {
  candidates: ThumbnailCandidate[];
  pageTitle: string | null;
}

/**
 * YouTube publishes every video's cover at a fixed path derived from the video
 * id, so the cover does not depend on parsing a 1.2 MB watch page. `maxres` is
 * the best image but is not generated for every upload — it 404s — while
 * `hqdefault` always exists, so the list degrades instead of failing.
 */
function youTubeThumbnailCandidates(pageUrl: string): ThumbnailCandidate[] {
  let videoId: string | null = null;
  try {
    const url = new URL(pageUrl);
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./u, "");
    if (hostname === "youtu.be") {
      videoId = url.pathname.slice(1).split("/")[0] ?? null;
    } else if (hostname === "youtube.com" || hostname === "youtube-nocookie.com") {
      videoId = url.searchParams.get("v")
        ?? /^\/(?:shorts|embed|live)\/([^/?#]+)/u.exec(url.pathname)?.[1]
        ?? null;
    }
  } catch {
    return [];
  }
  if (videoId === null || !/^[A-Za-z0-9_-]{6,20}$/u.test(videoId)) return [];
  return ["maxresdefault", "sddefault", "hqdefault"].map(variant => ({
    url: `https://i.ytimg.com/vi/${videoId}/${variant}.jpg`,
    source: "page_metadata" as const,
  }));
}

/**
 * oEmbed endpoints for hosts whose pages a Worker cannot reliably fetch.
 *
 * YouTube answers Cloudflare's egress with something other than the watch page:
 * a share-sheet capture came back with a cover (i.ytimg.com is a CDN and serves
 * fine) but no title, because the HTML holding the <title> never arrived. oEmbed
 * is a small documented JSON endpoint on a different path and does answer, and
 * it is already used elsewhere in this codebase for the same reason.
 */
function oEmbedEndpoint(pageUrl: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(pageUrl).hostname.toLowerCase().replace(/^(?:www|m|music|old|np)\./u, "");
  } catch {
    return null;
  }
  const encoded = encodeURIComponent(pageUrl);
  if (hostname === "youtube.com" || hostname === "youtu.be" || hostname === "youtube-nocookie.com") {
    return `https://www.youtube.com/oembed?format=json&url=${encoded}`;
  }
  if (hostname === "vimeo.com") return `https://vimeo.com/api/oembed.json?url=${encoded}`;
  if (hostname === "reddit.com") return `https://www.reddit.com/oembed?url=${encoded}`;
  return null;
}

interface OEmbedResult {
  title: string | null;
  thumbnailUrl: string | null;
}

/** Resolves o embed for thumbnail discovery. */
async function resolveOEmbed(pageUrl: string): Promise<OEmbedResult | null> {
  const endpoint = oEmbedEndpoint(pageUrl);
  if (endpoint === null) return null;
  try {
    const response = await safeFetch(endpoint, "application/json");
    if (!response.ok) return null;
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, 64 * 1024)),
    );
    if (typeof payload !== "object" || payload === null) return null;
    const title = (payload as { title?: unknown }).title;
    const thumbnail = (payload as { thumbnail_url?: unknown }).thumbnail_url;
    return {
      title: typeof title === "string" && title.trim().length > 0
        ? collapseWhitespace(title).slice(0, 300)
        : null,
      thumbnailUrl: typeof thumbnail === "string" && thumbnail.length > 0 ? thumbnail : null,
    };
  } catch {
    return null;
  }
}

/** Extracts the best available page title from metadata or the title element. */
function pageTitleOf(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,600}?)<\/title>/iu.exec(html);
  if (match?.[1] === undefined) return null;
  const title = collapseWhitespace(decodeEntities(match[1].replace(/<[^>]*>/gu, " ")))
    .slice(0, 300);
  return title.length === 0 ? null : title;
}

/** Fetches a page and returns title plus ordered, validated image candidates. */
export async function scanPageForThumbnail(pageUrl: string): Promise<PageThumbnailScan> {
  // Derived covers come first: they need no page parse, so they survive a page
  // that is too large, bot-gated, or served without its og tags.
  const candidates: ThumbnailCandidate[] = [...youTubeThumbnailCandidates(pageUrl)];
  // oEmbed before the page fetch, because for the hosts it covers the page
  // fetch is exactly what does not work.
  const oEmbed = await resolveOEmbed(pageUrl);
  let pageTitle: string | null = oEmbed?.title ?? null;
  if (oEmbed?.thumbnailUrl !== null && oEmbed?.thumbnailUrl !== undefined) {
    candidates.push({ url: oEmbed.thumbnailUrl, source: "page_metadata" });
  }
  try {
    const response = await safeFetch(pageUrl, "text/html,application/xhtml+xml");
    if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
      const bytes = await boundedBytesTruncated(response, MAX_HTML_BYTES);
      const html = new TextDecoder().decode(bytes);
      pageTitle ??= pageTitleOf(html);
      const metadata = metadataImage(html, pageUrl);
      if (metadata !== null) candidates.push({ url: metadata, source: "page_metadata" });
      for (const icon of iconImages(html, pageUrl).slice(0, 3)) {
        candidates.push({ url: icon, source: "favicon" });
      }
    }
  } catch {
    // A page that cannot be fetched may still expose the conventional favicon.
  }
  candidates.push({ url: new URL("/favicon.ico", pageUrl).toString(), source: "favicon" });
  return {
    candidates: [...new Map(candidates.map(candidate => [candidate.url, candidate])).values()],
    pageTitle,
  };
}

/** Finds page thumbnail candidates for thumbnail discovery. */
export async function findPageThumbnailCandidates(
  pageUrl: string,
): Promise<ThumbnailCandidate[]> {
  return (await scanPageForThumbnail(pageUrl)).candidates;
}

/** Finds page thumbnail for thumbnail discovery. */
export async function findPageThumbnail(pageUrl: string): Promise<string | null> {
  return (await findPageThumbnailCandidates(pageUrl))[0]?.url ?? null;
}

/** Fetches, validates, transforms, and stores one thumbnail candidate. */
export async function ingestThumbnailCandidate(
  env: Env,
  bookmarkId: string,
  candidateUrl: string,
  source: ThumbnailSource,
): Promise<boolean> {
  if (isPlaceholderThumbnail(candidateUrl)) return false;
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
                SET thumbnail_id = ?
              WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(thumbnailId, bookmarkId),
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
