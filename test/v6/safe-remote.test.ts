import { afterEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "../../src/v6/adapters/safe-remote";

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
});
