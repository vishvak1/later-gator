export const FIXED_FOLDERS = [
  { id: "folder_social_posts", slug: "social-posts", name: "Social Posts", aiDestination: true },
  { id: "folder_articles", slug: "articles", name: "Articles", aiDestination: true },
  { id: "folder_videos_talks", slug: "videos-talks", name: "Videos & Talks", aiDestination: true },
  { id: "folder_code", slug: "code", name: "Code", aiDestination: true },
  {
    id: "folder_docs_reference",
    slug: "docs-reference",
    name: "Docs & Reference",
    aiDestination: true,
  },
  { id: "folder_papers", slug: "papers", name: "Papers", aiDestination: true },
  {
    id: "folder_websites_apps",
    slug: "websites-apps",
    name: "Websites & Apps",
    aiDestination: true,
  },
  {
    id: "folder_need_review",
    slug: "need-review",
    name: "Need for Review",
    aiDestination: true,
  },
  { id: "folder_unsorted", slug: "unsorted", name: "Unsorted", aiDestination: false },
  { id: "folder_imports", slug: "imports", name: "Imports", aiDestination: false },
] as const;

export const UNSORTED_FOLDER_ID = "folder_unsorted";

export function deterministicFolderForHostname(hostname: string): "Social Posts" | null {
  const normalized = hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
  return normalized === "x.com" ||
      normalized.endsWith(".x.com") ||
      normalized === "twitter.com" ||
      normalized.endsWith(".twitter.com")
    ? "Social Posts"
    : null;
}
