import { describe, expect, it } from "vitest";
import { calculatePreviewDimensions } from "../../src/v6/application/thumbnails";

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
