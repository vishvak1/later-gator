import {
  boundedBytes,
  boundedBytesTruncated,
  resolveRedirectTarget,
  safeFetch,
} from "../adapters/safe-remote";

// Script-heavy pages push their metadata far down the document: a YouTube
// watch page is ~1.3 MB and emits og/meta tags past the 800 KB mark. Reading
// less than the whole document is fine, but the budget has to clear those.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 2400;
const MAX_EXTERNAL_LINKS = 2;

export interface XPostContext {
  author: string | null;
  text: string;
  externalUrls: string[];
}

export interface PageContext {
  pageTitle: string | null;
  siteName: string | null;
  metaDescription: string | null;
  excerpt: string | null;
  xPost: XPostContext | null;
  /** Publisher or channel, from a structured source rather than page text. */
  creator: string | null;
  /** Titles of the items a listing page collects, when the page is a listing. */
  entries: string[] | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/gu, (_, digits: string) => {
      const code = Number.parseInt(digits, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/giu, (match, name: string) =>
      NAMED_ENTITIES[name.toLowerCase()] ?? match,
    );
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripTags(html: string): string {
  return collapseWhitespace(decodeEntities(html.replace(/<[^>]*>/gu, " ")));
}

function metaContent(html: string, key: string, attribute: "name" | "property"): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+${attribute}=["']${key}["'][^>]+content=["']([^"']+)["']`,
      "iu",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${key}["']`,
      "iu",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1] !== undefined) return collapseWhitespace(decodeEntities(match[1]));
  }
  return null;
}

function pageExcerpt(html: string): string | null {
  const body =
    /<body[^>]*>([\s\S]*)<\/body>/iu.exec(html)?.[1] ?? html;
  const cleaned = body
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<svg[\s\S]*?<\/svg>/giu, " ")
    .replace(/<(?:nav|header|footer|aside)[\s\S]*?<\/(?:nav|header|footer|aside)>/giu, " ");
  const text = stripTags(cleaned).slice(0, MAX_EXCERPT_CHARS);
  return text.length < 80 ? null : text;
}

function withoutLinkOnlyContent(value: string): string {
  return collapseWhitespace(
    value
      .replace(/https?:\/\/\S+/giu, " ")
      .replace(/\b(?:www\.|pic\.twitter\.com\/|t\.co\/)\S+/giu, " "),
  );
}

/** Titles and link-only placeholders are metadata, not primary page content. */
export function hasPrimaryContentText(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const text = withoutLinkOnlyContent(value);
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * A description supplied by a capture surface counts as primary content unless
 * it only repeats the title, which carries no information the title lacks.
 */
export function hasPrimarySourceDescription(
  description: string | null | undefined,
  bookmarkTitle: string | null,
): boolean {
  if (!hasPrimaryContentText(description)) return false;
  const normalized = collapseWhitespace(description ?? "").toLocaleLowerCase("en-US");
  return normalized !== collapseWhitespace(bookmarkTitle ?? "").toLocaleLowerCase("en-US");
}

export function hasPrimaryPageContent(
  context: PageContext | null,
  bookmarkTitle: string | null = null,
): boolean {
  if (context === null) return false;
  if (hasPrimaryContentText(context.xPost?.text)) return true;
  // What a listing collects is its content, whatever its description says.
  if (context.entries !== null && context.entries.length > 0) return true;
  const metadataOnly = new Set(
    [bookmarkTitle, context.pageTitle, context.siteName]
      .filter((value): value is string => value !== null)
      .map((value) => collapseWhitespace(value).toLocaleLowerCase("en-US")),
  );
  return [context.metaDescription, context.excerpt].some(
    (value) =>
      hasPrimaryContentText(value) &&
      !metadataOnly.has(collapseWhitespace(value ?? "").toLocaleLowerCase("en-US")),
  );
}

export function isXStatusUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    return (
      (hostname === "x.com" || hostname === "twitter.com" || hostname === "mobile.twitter.com") &&
      /\/status(?:es)?\/\d+/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isXInternalUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === "x.com" ||
      hostname.endsWith(".x.com") ||
      hostname === "twitter.com" ||
      hostname.endsWith(".twitter.com") ||
      hostname === "t.co" ||
      hostname === "pic.twitter.com" ||
      hostname.endsWith(".twimg.com")
    );
  } catch {
    return true;
  }
}

/**
 * Scoped deliberately to playlist pages. A watch page carries the same listing
 * structure for its sidebar recommendations, and those titles are unrelated to
 * the bookmark; harvesting them would poison the tags.
 */
export function isYouTubePlaylistUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./u, "");
    return (
      (hostname === "youtube.com" || hostname === "youtube-nocookie.com") &&
      url.pathname === "/playlist" &&
      url.searchParams.get("list") !== null
    );
  } catch {
    return false;
  }
}

const LISTING_ENTRY_PATTERNS = [
  /"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.){3,200})"/gu,
  /"playlistVideoRenderer":\{[\s\S]{0,400}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.){3,200})"/gu,
  /"accessibilityContext":\{"label":"((?:[^"\\]|\\.){3,200})"/gu,
];
const DURATION_LIKE =
  /^\d+\s+(?:hour|minute|second)s?(?:,\s*\d+\s+(?:hour|minute|second)s?)*$/iu;
const MAX_LISTING_ENTRIES = 30;

/**
 * Recovers the titles a listing page renders from client-side data. Several
 * independent shapes carry the same titles, so one of them changing degrades
 * the result instead of emptying it. An empty result is always survivable:
 * callers keep whatever metadata the page published.
 */
export function listingEntries(html: string): string[] {
  for (const pattern of LISTING_ENTRY_PATTERNS) {
    const found = new Set<string>();
    for (const match of html.matchAll(pattern)) {
      if (match[1] === undefined) continue;
      let value: string;
      try {
        value = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        continue;
      }
      const collapsed = collapseWhitespace(value);
      if (collapsed.length < 3 || DURATION_LIKE.test(collapsed)) continue;
      found.add(collapsed);
      if (found.size >= MAX_LISTING_ENTRIES) break;
    }
    if (found.size > 0) return [...found];
  }
  return [];
}

/** oEmbed is a documented endpoint, unlike the rendered page payload. */
async function resolveCreator(rawUrl: string): Promise<string | null> {
  try {
    const response = await safeFetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(rawUrl)}`,
      "application/json",
    );
    if (!response.ok) return null;
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, 64 * 1024)),
    );
    const author = (payload as { author_name?: unknown }).author_name;
    return typeof author === "string" && author.length > 0 ? author : null;
  } catch {
    return null;
  }
}

async function resolveXPost(rawUrl: string): Promise<XPostContext | null> {
  const oembedUrl =
    "https://publish.twitter.com/oembed?omit_script=1&dnt=1&hide_thread=1&url=" +
    encodeURIComponent(rawUrl);
  const response = await safeFetch(oembedUrl, "application/json");
  if (!response.ok) return null;
  const bytes = await boundedBytes(response, 128 * 1024);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const html = (payload as { html?: unknown }).html;
  const author = (payload as { author_name?: unknown }).author_name;
  if (typeof html !== "string" || html.length === 0) return null;

  const postBody = /<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(html)?.[1] ?? "";
  const text = stripTags(postBody).slice(0, 2000);
  const shortLinks = [...new Set(html.match(/https:\/\/t\.co\/[A-Za-z0-9]+/gu) ?? [])];
  const externalUrls: string[] = [];
  for (const shortLink of shortLinks) {
    if (externalUrls.length >= MAX_EXTERNAL_LINKS) break;
    const destination = await resolveRedirectTarget(shortLink).catch(() => null);
    if (destination !== null && !isXInternalUrl(destination)) {
      externalUrls.push(destination);
    }
  }
  return {
    author: typeof author === "string" && author.length > 0 ? author : null,
    text,
    externalUrls,
  };
}

/**
 * Fetches bounded page context to make AI organization smarter. Every failure
 * degrades to null; organization never fails because a page was unreachable.
 */
export async function resolvePageContext(rawUrl: string): Promise<PageContext | null> {
  try {
    if (isXStatusUrl(rawUrl)) {
      const xPost = await resolveXPost(rawUrl);
      if (xPost === null) return null;
      return {
        pageTitle: null,
        siteName: "X",
        metaDescription: null,
        excerpt: null,
        xPost,
        creator: xPost.author,
        entries: null,
      };
    }
    const response = await safeFetch(rawUrl, "text/html,application/xhtml+xml");
    if (!response.ok || response.headers.get("content-type")?.includes("text/html") !== true) {
      return null;
    }
    const html = new TextDecoder().decode(
      await boundedBytesTruncated(response, MAX_HTML_BYTES),
    );
    const titleMatch = /<title[^>]*>([\s\S]{0,600}?)<\/title>/iu.exec(html);
    const listing = isYouTubePlaylistUrl(rawUrl);
    const entries = listing ? listingEntries(html) : [];
    return {
      pageTitle: titleMatch?.[1] === undefined ? null : stripTags(titleMatch[1]).slice(0, 300),
      siteName: metaContent(html, "og:site_name", "property"),
      metaDescription:
        metaContent(html, "description", "name") ??
        metaContent(html, "og:description", "property") ??
        metaContent(html, "twitter:description", "name"),
      excerpt: pageExcerpt(html),
      xPost: null,
      creator: listing ? await resolveCreator(rawUrl) : null,
      entries: entries.length === 0 ? null : entries,
    };
  } catch {
    return null;
  }
}
