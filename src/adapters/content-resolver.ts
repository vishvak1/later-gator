import type { RaindropItem } from "./raindrop-client";

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 128_000;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/giu;

export interface ResolvedBookmarkContent {
  title: string;
  excerpt: string;
  link: string;
  substituted: boolean;
}

export interface BookmarkContentResolver {
  resolve(bookmark: RaindropItem): Promise<ResolvedBookmarkContent>;
}

export class SafeBookmarkContentResolver implements BookmarkContentResolver {
  constructor(private readonly request: typeof fetch = fetch) {}

  async resolve(bookmark: RaindropItem): Promise<ResolvedBookmarkContent> {
    const cleanedTitle = cleanXTitle(bookmark.title);
    if (!isXUrl(bookmark.link)) {
      return {
        title: cleanedTitle,
        excerpt: bookmark.excerpt,
        link: bookmark.link,
        substituted: false,
      };
    }
    const candidates = extractExternalCandidates(`${cleanedTitle}\n${bookmark.excerpt}`);
    if (candidates.length !== 1 || !hasUsefulDescription(cleanedTitle, bookmark.excerpt)) {
      return {
        title: cleanedTitle,
        excerpt: bookmark.excerpt,
        link: bookmark.link,
        substituted: false,
      };
    }
    try {
      const finalUrl = await followRedirects(candidates[0] ?? "", this.request);
      if (isXUrl(finalUrl)) throw new Error("Self-referential X destination");
      const title = await readPageTitle(finalUrl, this.request);
      return {
        title: title ?? cleanedTitle,
        excerpt: bookmark.excerpt,
        link: finalUrl,
        substituted: true,
      };
    } catch {
      return {
        title: cleanedTitle,
        excerpt: bookmark.excerpt,
        link: bookmark.link,
        substituted: false,
      };
    }
  }
}

export function cleanXTitle(value: string): string {
  return value
    .replace(/^.+?\s+on\s+(?:X|Twitter):\s*["“]?/iu, "")
    .replace(/["”]?\s*\/\s*(?:X|Twitter)\s*$/iu, "")
    .replace(/\s+https?:\/\/t\.co\/\S+\s*$/iu, "")
    .trim();
}

export function extractExternalCandidates(value: string): string[] {
  const candidates = value.match(URL_PATTERN) ?? [];
  return [...new Set(candidates.map(trimUrlPunctuation))]
    .filter((url) => {
      try {
        return !isXUrl(url) && isSafePublicHttpUrl(new URL(url));
      } catch {
        return false;
      }
    });
}

export function isXUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/u, "");
    return (
      hostname === "x.com" ||
      hostname.endsWith(".x.com") ||
      hostname === "twitter.com" ||
      hostname.endsWith(".twitter.com")
    );
  } catch {
    return false;
  }
}

export function isSafePublicHttpUrl(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (
    (url.protocol === "https:" && url.port !== "" && url.port !== "443") ||
    (url.protocol === "http:" && url.port !== "" && url.port !== "80")
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  ) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) {
    const octets = hostname.split(".").map(Number);
    const [first = 0, second = 0] = octets;
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      return false;
    }
  }
  return !hostname.includes(":");
}

async function followRedirects(input: string, request: typeof fetch): Promise<string> {
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isSafePublicHttpUrl(current)) throw new Error("Unsafe destination");
    const response = await request(current, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status < 300 || response.status >= 400) return current.toString();
    if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
    const location = response.headers.get("location");
    if (location === null) throw new Error("Redirect has no destination");
    current = new URL(location, current);
  }
  throw new Error("Unreachable");
}

async function readPageTitle(
  input: string,
  request: typeof fetch,
): Promise<string | null> {
  const url = new URL(input);
  if (!isSafePublicHttpUrl(url)) return null;
  const response = await request(url, {
    method: "GET",
    redirect: "manual",
    headers: { range: `bytes=0-${(MAX_HTML_BYTES - 1).toString()}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_HTML_BYTES) return null;
  const bytes = await readBoundedBytes(response, MAX_HTML_BYTES);
  if (bytes === null) return null;
  const html = new TextDecoder().decode(bytes);
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = match?.[1]?.replace(/\s+/gu, " ").trim().slice(0, 1_000);
  return title === undefined || title.length === 0 ? null : title;
}

async function readBoundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function hasUsefulDescription(title: string, excerpt: string): boolean {
  return `${title} ${excerpt}`.replace(URL_PATTERN, "").trim().length >= 20;
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[.,!?;:]+$/u, "");
}
