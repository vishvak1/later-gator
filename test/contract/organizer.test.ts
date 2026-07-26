import { describe, expect, it, vi } from "vitest";
import {
  AnthropicOrganizer,
  OpenAiOrganizer,
  OrganizerError,
  WorkersAiOrganizer,
} from "../../src/adapters/organizer";

const input = {
  title: "Reference",
  excerpt: "A useful source.",
  link: "https://example.test",
  registry: [{ name: "machine-learning", count: 2 }],
  personalInstructions: "",
  correction: null,
};
const result = {
  tags: ["machine-learning"],
  description: "Useful.",
  folder: "Articles",
  confidence: "high",
  notes: "",
};

describe("organization provider contracts", () => {
  it("validates Workers AI JSON-mode output at runtime", async () => {
    const run = vi.fn(
      (model: string, request: Record<string, unknown>): Promise<unknown> => {
        expect(model).toBe("test-model");
        expect(request).toMatchObject({
          response_format: { type: "json_schema" },
        });
        expect(JSON.stringify(request)).toContain(
          '"notes":{"type":"string","maxLength":1000}',
        );
        expect(JSON.stringify(request)).not.toContain(
          '"type":["string","null"]',
        );
        return Promise.resolve({ response: result });
      },
    );
    const organizer = new WorkersAiOrganizer(
      run,
      "test-model",
    );
    await expect(organizer.organize(input)).resolves.toEqual(result);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects malformed Workers AI output", async () => {
    const organizer = new WorkersAiOrganizer(
      () => Promise.resolve({ response: { tags: [] } }),
      "test-model",
    );
    await expect(organizer.organize(input)).rejects.toMatchObject({
      kind: "schema",
      code: "invalid_schema",
    });
  });

  it("uses OpenAI structured output without provider-side storage", async () => {
    let requestBody: unknown;
    const organizer = new OpenAiOrganizer(
      "test-key",
      "test-model",
      (_url, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(
          Response.json({
            output: [{ content: [{ type: "output_text", text: JSON.stringify(result) }] }],
          }),
        );
      },
    );
    await expect(organizer.organize(input)).resolves.toEqual(result);
    expect(requestBody).toMatchObject({
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
  });

  it("uses Anthropic JSON-schema output and classifies rate limits as transient", async () => {
    const success = new AnthropicOrganizer(
      "test-key",
      "test-model",
      () =>
        Promise.resolve(
          Response.json({
            content: [{ type: "text", text: JSON.stringify(result) }],
          }),
        ),
    );
    await expect(success.organize(input)).resolves.toEqual(result);

    const limited = new AnthropicOrganizer(
      "test-key",
      "test-model",
      () =>
        Promise.resolve(
          Response.json(
            { error: { type: "rate_limit" } },
            { status: 429, headers: { "retry-after": "60" } },
          ),
        ),
    );
    await expect(limited.organize(input)).rejects.toBeInstanceOf(OrganizerError);
    await expect(limited.organize(input)).rejects.toMatchObject({
      kind: "transient",
      code: "http_429",
    });
  });
});
