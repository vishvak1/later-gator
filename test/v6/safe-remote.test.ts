import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedBytesTruncated,
  resolveRedirectTarget,
  safeFetch,
} from "../../src/v6/adapters/safe-remote";

describe("remote metadata retrieval", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests public pages with broadly compatible browser metadata headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await safeFetch("https://example.com/watch", "text/html,application/xhtml+xml");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toContain("Mozilla/5.0");
    expect(headers.get("user-agent")).toContain("LaterGator/6.0");
    expect(headers.get("accept-language")).toBe("en-US,en;q=0.9");
  });

  it("truncates an oversized document instead of discarding it", async () => {
    const body = "x".repeat(4096);
    const bytes = await boundedBytesTruncated(new Response(body), 1024);
    expect(bytes.byteLength).toBe(1024);
  });

  it("returns a short document untouched", async () => {
    const bytes = await boundedBytesTruncated(new Response("hello"), 1024);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});

describe("shortlink resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks shorteners with a plain agent so they answer with a redirect", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: "https://www.youtube.com/playlist?list=PL123" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveRedirectTarget("https://t.co/abc123")).toBe(
      "https://www.youtube.com/playlist?list=PL123",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).not.toContain("Mozilla/5.0");
  });

  it("recovers the destination from a scripted interstitial answered with 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          '<head><noscript><META http-equiv="refresh" content="0;URL=https://www.youtube.com/playlist?list=PL123"></noscript></head>' +
            '<script>location.replace("https:\\/\\/www.youtube.com\\/playlist?list=PL123")</script>',
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    expect(await resolveRedirectTarget("https://t.co/abc123")).toBe(
      "https://www.youtube.com/playlist?list=PL123",
    );
  });

  it("ignores an interstitial that points nowhere usable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><body>Nothing to see.</body></html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    expect(await resolveRedirectTarget("https://t.co/abc123")).toBeNull();
  });
});
