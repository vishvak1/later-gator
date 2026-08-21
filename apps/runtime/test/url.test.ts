import { describe, expect, it } from "vitest";
import { normalizeBookmarkUrl, UnsafeBookmarkUrlError } from "../src/domain/url";

describe("bookmark URL identity", () => {
  it("normalizes host, default port, fragment, and empty path", () => {
    expect(normalizeBookmarkUrl("HTTPS://Example.COM:443?b=2&a=1#section")).toEqual({
      url: "HTTPS://Example.COM:443?b=2&a=1#section",
      normalizedUrl: "https://example.com/?b=2&a=1",
      hostname: "example.com",
    });
  });

  it("preserves path case and query order", () => {
    expect(normalizeBookmarkUrl("https://example.com/SomePath?z=1&a=2").normalizedUrl).toBe(
      "https://example.com/SomePath?z=1&a=2",
    );
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "not a URL"])(
    "rejects unsafe URL %s",
    (value) => {
      expect(() => normalizeBookmarkUrl(value)).toThrow(UnsafeBookmarkUrlError);
    },
  );
});
