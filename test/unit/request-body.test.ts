import { describe, expect, it } from "vitest";
import { readBoundedUrlEncodedForm } from "../../src/routes/request-body";

describe("bounded form reader", () => {
  it("parses a small URL-encoded form", async () => {
    const request = new Request("https://example.test/form", {
      method: "POST",
      body: "credential=secret-value&provider=openai",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const result = await readBoundedUrlEncodedForm(request, 1_024);
    expect(result.get("credential")).toBe("secret-value");
    expect(result.get("provider")).toBe("openai");
  });

  it("stops reading when the actual body exceeds the ceiling", async () => {
    const request = new Request("https://example.test/form", {
      method: "POST",
      body: `credential=${"x".repeat(100)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    await expect(readBoundedUrlEncodedForm(request, 16)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects other content types", async () => {
    const request = new Request("https://example.test/form", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    await expect(readBoundedUrlEncodedForm(request, 1_024)).rejects.toMatchObject({
      status: 415,
    });
  });
});
