import { describe, expect, it } from "vitest";
import {
  appendReviewReason,
  ensurePreservationBlock,
  isXHostname,
  normalizeTags,
  recoverOriginalExcerpt,
  routeFolder,
} from "../../src/domain/organization-rules";

describe("organization rules", () => {
  it("uses label-bound domain matching before the model folder", () => {
    expect(routeFolder("https://docs.github.com/example", "Articles")).toBe("Code");
    expect(routeFolder("https://github.com.attacker.example/file", "Articles")).toBe(
      "Articles",
    );
  });

  it("routes PDFs and falls back safely", () => {
    expect(routeFolder("https://example.test/research.PDF", "Articles")).toBe("Papers");
    expect(routeFolder("not a URL", "Articles")).toBe("Websites & Apps");
  });

  it("normalizes, reuses singular registry entries, deduplicates, and rejects noise", () => {
    expect(
      normalizeTags(
        [" Machine Learning ", "APIs", "api", "three word topic", "Articles", "CSS"],
        ["api", "machine-learning"],
      ),
    ).toEqual({
      accepted: ["machine-learning", "api", "css"],
      rejected: ["three word topic", "Articles"],
    });
  });

  it("preserves user notes and adds the original content exactly once", () => {
    const first = ensurePreservationBlock(
      "My private note",
      "https://example.test/original",
      "Original excerpt",
    );
    expect(first).toContain("My private note");
    expect(first).toContain("original-url: https://example.test/original");
    expect(recoverOriginalExcerpt(first)).toBe("Original excerpt");
    expect(ensurePreservationBlock(first, "https://changed.test", "changed")).toBe(first);
  });

  it("uses label boundaries for X detection and idempotent review reasons", () => {
    expect(isXHostname("mobile.x.com")).toBe(true);
    expect(isXHostname("x.com.attacker.example")).toBe(false);
    const note = appendReviewReason("", "invalid output");
    expect(appendReviewReason(note, "invalid output")).toBe(note);
  });
});
