import { describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  OpenAiProvider,
  ProviderConnectionError,
  WorkersAiProvider,
} from "../../src/adapters/organization-provider";

describe("Organization provider connection contracts", () => {
  it("tests Workers AI with synthetic JSON and validates the application boundary", async () => {
    const run = vi.fn(
      (model: string, input: Record<string, unknown>): Promise<unknown> => {
        expect(model).toBe("test-model");
        expect(JSON.stringify(input)).not.toContain("bookmark");
        expect(input).toMatchObject({
          response_format: { type: "json_schema" },
          max_tokens: 32,
        });
        return Promise.resolve({ response: { ok: "later-gator" } });
      },
    );
    await new WorkersAiProvider(run, "test-model").testConnection();

    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects malformed Workers AI output even after inference succeeds", async () => {
    const run = vi.fn(
      (model: string, input: Record<string, unknown>): Promise<unknown> => {
        expect(model).toBe("test-model");
        expect(input).toHaveProperty("response_format");
        return Promise.resolve({ response: { ok: "wrong" } });
      },
    );
    await expect(
      new WorkersAiProvider(run, "test-model").testConnection(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses OpenAI Responses structured output without bookmark content", async () => {
    const request = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer redacted-openai-key");
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({
        model: "openai-test-model",
        store: false,
        text: { format: { type: "json_schema", strict: true } },
      });
      expect(JSON.stringify(body)).not.toContain("https://bookmark.example");
      return Promise.resolve(
        Response.json({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"ok":"later-gator"}' }],
            },
          ],
        }),
      );
    });

    await new OpenAiProvider(
      "redacted-openai-key",
      "openai-test-model",
      request,
    ).testConnection();
  });

  it("uses Anthropic Messages structured output and required headers", async () => {
    const request = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("redacted-anthropic-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({
        model: "anthropic-test-model",
        output_config: { format: { type: "json_schema" } },
      });
      return Promise.resolve(
        Response.json({
          content: [{ type: "text", text: '{"ok":"later-gator"}' }],
        }),
      );
    });

    await new AnthropicProvider(
      "redacted-anthropic-key",
      "anthropic-test-model",
      request,
    ).testConnection();
  });

  it("classifies external authentication failures without returning provider bodies", async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          { error: { message: "sensitive upstream detail" } },
          { status: 401 },
        ),
      ),
    );

    const error = await new OpenAiProvider("bad-key", "test-model", request)
      .testConnection()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderConnectionError);
    expect(error).toMatchObject({ code: "authentication" });
    expect(String(error)).not.toContain("sensitive upstream detail");
  });
});
