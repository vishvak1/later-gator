import {
  CONTENT_FOLDER_NAMES,
  DOMAIN_FOLDER_MAP,
  FOLDER_NAMES,
} from "./seed";
import type {
  ContentFolderName,
  FolderName,
} from "./schemas";

const RESERVED_TAGS = new Set([
  ...FOLDER_NAMES.map(normalizeTagBase),
  "unsorted",
  "need-review",
  "review",
  "article",
  "articles",
  "video",
  "videos",
  "paper",
  "papers",
  "website",
  "websites",
]);
const SINGULAR_EXCEPTIONS = new Set([
  "ai",
  "api",
  "css",
  "devops",
  "javascript",
  "kubernetes",
  "news",
  "ops",
  "saas",
  "typescript",
  "ux",
]);

export interface NormalizedTags {
  accepted: string[];
  rejected: string[];
}

export function routeFolder(
  link: string,
  modelFolder: ContentFolderName,
): ContentFolderName {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "Websites & Apps";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Websites & Apps";

  const hostname = url.hostname.toLowerCase();
  for (const [domain, folder] of Object.entries(DOMAIN_FOLDER_MAP)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return folder;
  }
  if (url.pathname.toLowerCase().endsWith(".pdf")) return "Papers";
  return CONTENT_FOLDER_NAMES.some((folder) => folder === modelFolder)
    ? modelFolder
    : "Websites & Apps";
}

export function normalizeTags(
  proposed: string[],
  registryNames: readonly string[],
): NormalizedTags {
  const registry = new Set(registryNames);
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const original of proposed) {
    const base = normalizeTagBase(original);
    const semanticWords = base.split("-").filter((word) => word.length > 0);
    if (
      base.length === 0 ||
      semanticWords.length > 2 ||
      RESERVED_TAGS.has(base)
    ) {
      rejected.push(original);
      continue;
    }

    const singular = singularize(base);
    const normalized = registry.has(base)
      ? base
      : registry.has(singular)
        ? singular
        : singular;
    if (normalized.length > 100 || RESERVED_TAGS.has(normalized)) {
      rejected.push(original);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      accepted.push(normalized);
    }
  }
  return { accepted, rejected };
}

export function ensurePreservationBlock(
  existingNote: string,
  originalUrl: string,
  originalExcerpt: string,
): string {
  const marker = "<!-- later-gator:v1";
  if (existingNote.includes(marker)) return existingNote;
  const block = [
    marker,
    `original-url: ${originalUrl}`,
    "original-excerpt:",
    originalExcerpt,
    "-->",
  ].join("\n");
  return existingNote.trim().length === 0 ? block : `${existingNote}\n\n${block}`;
}

export function recoverOriginalExcerpt(note: string): string | null {
  const block = /<!-- later-gator:v1\s+original-url:\s*[^\n]*\noriginal-excerpt:\n([\s\S]*?)\n-->/u.exec(
    note,
  );
  const excerpt = block?.[1]?.trim();
  return excerpt === undefined || excerpt.length === 0 ? null : excerpt;
}

export function appendReviewReason(note: string, reason: string): string {
  const safeReason = reason.trim().slice(0, 500);
  const line = `Later Gator review: ${safeReason}`;
  return note.includes(line) ? note : `${note}${note.length === 0 ? "" : "\n\n"}${line}`;
}

export function isXHostname(hostnameInput: string): boolean {
  const hostname = hostnameInput.toLowerCase();
  return (
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  );
}

export function folderNameFromId(
  folderIds: Partial<Record<FolderName, number>>,
  id: number,
): FolderName | null {
  for (const name of FOLDER_NAMES) {
    if (folderIds[name] === id) return name;
  }
  return null;
}

function normalizeTagBase(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function singularize(tag: string): string {
  if (SINGULAR_EXCEPTIONS.has(tag)) return tag;
  const words = tag.split("-");
  const last = words.at(-1);
  if (last === undefined) return tag;
  let singular = last;
  if (last.endsWith("ies") && last.length > 4) {
    singular = `${last.slice(0, -3)}y`;
  } else if (
    last.endsWith("s") &&
    !last.endsWith("ss") &&
    !last.endsWith("us") &&
    last.length > 3
  ) {
    singular = last.slice(0, -1);
  }
  words[words.length - 1] = singular;
  return words.join("-");
}
