import { z } from "zod";
import type { PageContext } from "../application/page-content";

export const retrievalDiagnosticSchema = z.strictObject({
  pageContextPresent: z.boolean(),
  pageTitleChars: z.number().int().nonnegative(),
  metaDescriptionChars: z.number().int().nonnegative(),
  excerptChars: z.number().int().nonnegative(),
  xPostChars: z.number().int().nonnegative(),
  externalLinkCount: z.number().int().nonnegative(),
  listingEntryCount: z.number().int().nonnegative(),
  browserAttempted: z.boolean(),
  primaryEvidencePresent: z.boolean(),
});

export type RetrievalDiagnostic = z.infer<typeof retrievalDiagnosticSchema>;

/** Builds a content-free retrieval summary suitable for D1 and Workers Logs. */
export function retrievalDiagnostic(
  context: PageContext | null,
  browserAttempted: boolean,
  primaryEvidencePresent: boolean,
): RetrievalDiagnostic {
  return {
    pageContextPresent: context !== null,
    pageTitleChars: context?.pageTitle?.length ?? 0,
    metaDescriptionChars: context?.metaDescription?.length ?? 0,
    excerptChars: context?.excerpt?.length ?? 0,
    xPostChars: context?.xPost?.text.length ?? 0,
    externalLinkCount: context?.xPost?.externalUrls.length ?? 0,
    listingEntryCount: context?.entries?.length ?? 0,
    browserAttempted,
    primaryEvidencePresent,
  };
}

/** Emits one redacted JSON event for AI-assisted Cloudflare log review. */
export function logRetrievalDiagnostic(
  diagnosticId: string,
  bookmarkId: string,
  diagnostic: RetrievalDiagnostic,
  safeCode: string | null,
): void {
  console.log({
    event: "later_gator.retrieval",
    diagnosticId,
    bookmarkId,
    safeCode,
    ...diagnostic,
  });
}
