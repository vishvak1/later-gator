import { describe, expect, it } from "vitest";
import {
  calculatePreviewDimensions,
  isPlaceholderThumbnail,
} from "../src/application/thumbnails";

describe("bookmark preview dimensions", () => {
  it("preserves landscape aspect ratio without cropping", () => {
    expect(calculatePreviewDimensions(2400, 1200)).toEqual({
      width: 960,
      height: 480,
    });
  });

  it("constrains tall previews while preserving their aspect ratio", () => {
    expect(calculatePreviewDimensions(1200, 3000)).toEqual({
      width: 640,
      height: 1600,
    });
  });

  it("does not enlarge a small source image", () => {
    expect(calculatePreviewDimensions(480, 320)).toEqual({
      width: 480,
      height: 320,
    });
  });
});

describe("site-wide default covers", () => {
  it("rejects the X default that a client-side navigation leaves in og:image", () => {
    expect(
      isPlaceholderThumbnail("https://abs.twimg.com/rweb/ssr/default/v2/og/image.png"),
    ).toBe(true);
  });

  it("keeps the real per-post image a server-side fetch returns", () => {
    expect(
      isPlaceholderThumbnail("https://pbs.twimg.com/media/HO4V1gIaIAAwzMh.jpg:large"),
    ).toBe(false);
    expect(isPlaceholderThumbnail("https://i.ytimg.com/vi/abc/maxresdefault.jpg")).toBe(false);
  });
});
