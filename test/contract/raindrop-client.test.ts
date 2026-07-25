import { describe, expect, it, vi } from "vitest";
import {
  RaindropClient,
  RaindropNetworkError,
  RaindropResponseError,
} from "../../src/adapters/raindrop-client";

describe("RaindropClient contract", () => {
  it("projects the authenticated-user envelope and sends auth only to Raindrop", async () => {
    const request = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      expect(url).toBe("https://api.raindrop.io/rest/v1/user");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer redacted-test-token");
      return Promise.resolve(
        Response.json({
          result: true,
          user: { _id: 42, fullName: "Test User", email: "not-projected@example.test" },
        }),
      );
    });

    const client = new RaindropClient("redacted-test-token", request);
    await expect(client.getCurrentUser()).resolves.toEqual({ id: 42, fullName: "Test User" });
  });

  it("invokes the request function without binding it to the client instance", async () => {
    const request = vi.fn(function (
      this: unknown,
    ): Promise<Response> {
      expect(this).toBeUndefined();
      return Promise.resolve(
        Response.json({
          result: true,
          user: { _id: 42, fullName: "Test User" },
        }),
      );
    });

    await expect(
      new RaindropClient("redacted-test-token", request).getCurrentUser(),
    ).resolves.toEqual({ id: 42, fullName: "Test User" });
  });

  it("retries read-only network failures before succeeding", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Network connection lost"))
      .mockResolvedValueOnce(
        Response.json({
          result: true,
          user: { _id: 42, fullName: "Test User" },
        }),
      );

    await expect(
      new RaindropClient("redacted-test-token", request).getCurrentUser(),
    ).resolves.toEqual({ id: 42, fullName: "Test User" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a read-only network failure after three attempts", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Network connection lost"));

    await expect(
      new RaindropClient("redacted-test-token", request).getCurrentUser(),
    ).rejects.toMatchObject(
      new RaindropNetworkError(3),
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("rejects an unsuccessful Raindrop envelope", async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ result: false })));
    const client = new RaindropClient("redacted-test-token", request);
    await expect(client.getCurrentUser()).rejects.toThrow();
  });

  it("rejects a response whose declared body exceeds the limit", async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("{}", { headers: { "content-length": "512001" } })),
    );
    const client = new RaindropClient("redacted-test-token", request);
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(
      RaindropResponseError,
    );
  });

  it("lists root and child collections and projects only onboarding fields", async () => {
    const request = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const child = url.endsWith("/childrens");
      return Promise.resolve(
        Response.json({
          result: true,
          items: [
            {
              _id: child ? 12 : 11,
              title: child ? "Child" : "Root",
              count: 0,
              ...(child ? { parent: { $id: 11 } } : {}),
              user: { $id: 42 },
              access: { level: 4 },
              public: false,
            },
          ],
        }),
      );
    });
    const collections = await new RaindropClient("redacted-test-token", request)
      .listCollections();
    expect(collections).toEqual([
      {
        id: 11,
        title: "Root",
        count: 0,
        parentId: null,
        userId: 42,
        accessLevel: 4,
      },
      {
        id: 12,
        title: "Child",
        count: 0,
        parentId: 11,
        userId: 42,
        accessLevel: 4,
      },
    ]);
  });

  it("uses URLSearchParams and bounded page sizes when listing bookmarks", async () => {
    const request = vi.fn<typeof fetch>((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      expect(url.pathname).toBe("/rest/v1/raindrops/-1");
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("perpage")).toBe("50");
      expect(url.searchParams.get("search")).toBe("tag:machine-learning");
      return Promise.resolve(Response.json({ result: true, items: [], count: 101 }));
    });
    const page = await new RaindropClient("redacted-test-token", request).listRaindrops(
      -1,
      { page: 2, perPage: 50, search: "tag:machine-learning" },
    );
    expect(page).toEqual({ items: [], totalCount: 101 });
  });

  it("moves only the supplied IDs and never includes bookmark content", async () => {
    const request = vi.fn<typeof fetch>((_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON body");
      expect(JSON.parse(init.body)).toEqual({
        ids: [101, 102],
        collection: { $id: -1 },
      });
      expect(init.body).not.toContain("title");
      expect(init.body).not.toContain("link");
      return Promise.resolve(Response.json({ result: true, modified: 2 }));
    });
    await new RaindropClient("redacted-test-token", request).moveRaindrops(
      11,
      [101, 102],
      -1,
    );
  });
});
