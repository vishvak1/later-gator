// Type-only imports from the Worker. esbuild erases these, so no server code
// is pulled into the browser bundle, but the API boundary stays honest: if a
// row shape changes in the Worker, the frontend stops compiling.
import type { BookmarkRow } from "../../src/v6/adapters/library-repository";

export type Bookmark = BookmarkRow;

export interface TagSummary {
  id: string;
  normalized_name: string;
  display_name: string;
  status: "active" | "retired";
  usage_count: number;
}

export interface FolderSummary {
  id: string;
  slug: string;
  name: string;
  kind: string;
  sort_order: number;
  is_ai_destination: number;
  bookmark_count: number;
}

export interface ImportSession {
  id: string;
  status: "preview" | "committing" | "committed" | "cancelled" | "expired";
  option: "reorganize" | "preserve";
  file_name: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  committed_rows: number;
  failed_rows: number;
  processed_rows: number;
}

export interface AutomationProgress {
  total: number;
  complete: number;
  pending: number;
  processing: number;
  waitingProvider: number;
  pausedOwner: number;
  review: number;
  failed: number;
  lastActivityAt: string | null;
}

export interface ProviderState {
  provider: string;
  model: string;
  operational_status: string;
  last_safe_error_code: string | null;
}

export interface BootstrapState {
  setupStatus: string;
  ownerAiPaused: boolean;
  activeImport: ImportSession | null;
  folders: FolderSummary[];
  tags: TagSummary[];
  sites: string[];
  trashCount: number;
  automationProgress: AutomationProgress;
  provider: ProviderState;
}

export interface BookmarkTag {
  id: string;
  display_name: string;
  normalized_name: string;
  source: string;
}

export interface RelatedBookmark {
  id: string;
  title: string;
  url: string;
  hostname: string;
  folder_name: string;
}

export interface BookmarkDetail extends Bookmark {
  tags: BookmarkTag[];
  relatedBookmarks: RelatedBookmark[];
  thumbnailAvailable: boolean;
}

export interface BookmarkPageResponse {
  bookmarks: Bookmark[];
  total: number;
  nextCursor: string | null;
}

export interface ImportPreview {
  importId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  option: string;
  expiresAt: string;
}
