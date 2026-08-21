// Type-only imports from the Worker. esbuild erases these, so no server code
// is pulled into the browser bundle, but the API boundary stays honest: if a
// row shape changes in the Worker, the frontend stops compiling.
import type { BookmarkRow } from "../../src/adapters/library-repository";
import type {
  AutomationProgress,
  ImportSession,
  ProviderState,
} from "../../src/domain/library-state";

export type { AutomationProgress, ImportSession, ProviderState };

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

export interface BootstrapState {
  setupStatus: string;
  ownerAiPaused: boolean;
  personalInstructions: string | null;
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
  diagnosticSummary: {
    pageContextPresent: boolean;
    pageTitleChars: number;
    metaDescriptionChars: number;
    excerptChars: number;
    xPostChars: number;
    externalLinkCount: number;
    listingEntryCount: number;
    browserAttempted: boolean;
    primaryEvidencePresent: boolean;
  } | null;
}

export interface XDestinationReviewItem {
  id: string;
  destinationUrl: string;
  existingBookmarkId: string | null;
  existingTitle: string | null;
  existingHostname: string | null;
  linkedPosts: RelatedBookmark[];
}

export interface XDestinationReview {
  postBookmarkId: string;
  items: XDestinationReviewItem[];
}

export interface BookmarkPageResponse {
  bookmarks: Bookmark[];
  total: number;
  nextCursor: string | null;
}
