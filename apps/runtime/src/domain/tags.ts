export interface CanonicalTagName {
  normalized: string;
  display: string;
}

const TAG_ALIASES: Readonly<Record<string, string>> = {
  ai: "artificial-intelligence",
};

/** Converts one tag label to its lowercase, hyphenated canonical key. */
export function normalizeTagName(value: string): CanonicalTagName {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 64)
    .replace(/-+$/gu, "");
  const canonical = TAG_ALIASES[normalized] ?? normalized;
  return { normalized: canonical, display: canonical };
}

/** Canonicalizes, de-duplicates, and bounds a list of tag labels. */
export function normalizeTagNames(values: Iterable<string>, limit = 50): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const tag = normalizeTagName(value).normalized;
    if (tag !== "") normalized.add(tag);
    if (normalized.size >= limit) break;
  }
  return [...normalized];
}
