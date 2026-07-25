import { describe, expect, it } from "vitest";
import {
  cleanXTitle,
  extractExternalCandidates,
  isSafePublicHttpUrl,
  isXUrl,
} from "../../src/adapters/content-resolver";

describe("X content resolution safety", () => {
  it("cleans the known X title wrapper and trailing short link", () => {
    expect(
      cleanXTitle('Ada on X: "Useful explanation here https://t.co/abc" / X'),
    ).toBe("Useful explanation here");
  });

  it("extracts only genuine non-X public candidates", () => {
    expect(
      extractExternalCandidates(
        "See https://example.com/post and https://x.com/user/status/1",
      ),
    ).toEqual(["https://example.com/post"]);
  });

  it("matches X hostnames at DNS boundaries only", () => {
    expect(isXUrl("https://mobile.x.com/a")).toBe(true);
    expect(isXUrl("https://notx.com/a")).toBe(false);
    expect(isXUrl("https://twitter.com.evil.test/a")).toBe(false);
  });

  it("rejects local, private, credentialed, and unusual-port targets", () => {
    expect(isSafePublicHttpUrl(new URL("http://127.0.0.1/a"))).toBe(false);
    expect(isSafePublicHttpUrl(new URL("http://192.168.1.2/a"))).toBe(false);
    expect(isSafePublicHttpUrl(new URL("https://user:pass@example.com/a"))).toBe(false);
    expect(isSafePublicHttpUrl(new URL("https://example.com:8443/a"))).toBe(false);
    expect(isSafePublicHttpUrl(new URL("https://example.com/a"))).toBe(true);
  });
});
