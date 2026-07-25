import { z } from "zod";
import type { ProviderChoice } from "../domain/schemas";
import { readBoundedJsonResponse } from "./bounded-json-response";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_RESPONSE_BYTES = 256_000;
const CONNECTION_PROMPT =
  'This is a connection test. Return exactly the requested JSON object with ok set to "later-gator".';
const CONNECTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "string", enum: ["later-gator"] },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

const ConnectionResultSchema = z.object({ ok: z.literal("later-gator") }).strict();
const WorkersAiEnvelopeSchema = z.looseObject({
  response: z.union([z.string(), z.unknown()]),
});
const OpenAiEnvelopeSchema = z.looseObject({
  output: z.array(
    z.looseObject({
      type: z.string(),
      content: z
        .array(
          z.looseObject({
            type: z.string(),
            text: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});
const AnthropicEnvelopeSchema = z.looseObject({
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
});

export type ProviderConnectionErrorCode =
  | "authentication"
  | "model"
  | "rate_limit"
  | "provider"
  | "invalid_response"
  | "missing_credential";

export class ProviderConnectionError extends Error {
  override readonly name = "ProviderConnectionError";

  constructor(
    readonly code: ProviderConnectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OrganizationProvider {
  testConnection(): Promise<void>;
}

export function createOrganizationProvider(
  choice: ProviderChoice,
  dependencies: {
    ai: Ai;
    credential: string | null;
    request?: typeof fetch;
  },
): OrganizationProvider {
  switch (choice.provider) {
    case "workers-ai":
      return new WorkersAiProvider(
        (model, input) => dependencies.ai.run(model, input),
        choice.model,
      );
    case "openai":
      return new OpenAiProvider(
        requireCredential(dependencies.credential),
        choice.model,
        dependencies.request,
      );
    case "anthropic":
      return new AnthropicProvider(
        requireCredential(dependencies.credential),
        choice.model,
        dependencies.request,
      );
  }
}

export class WorkersAiProvider implements OrganizationProvider {
  constructor(
    private readonly run: (
      model: string,
      input: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly model: string,
  ) {}

  async testConnection(): Promise<void> {
    let payload: unknown;
    try {
      payload = await this.run(this.model, {
        messages: [{ role: "user", content: CONNECTION_PROMPT }],
        response_format: {
          type: "json_schema",
          json_schema: CONNECTION_JSON_SCHEMA,
        },
        max_tokens: 32,
        temperature: 0,
      });
    } catch {
      throw new ProviderConnectionError("provider", "Workers AI connection test failed");
    }

    const envelope = WorkersAiEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new ProviderConnectionError("invalid_response", "Workers AI returned an invalid response");
    }
    parseConnectionResult(envelope.data.response);
  }
}

export class OpenAiProvider implements OrganizationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async testConnection(): Promise<void> {
    const response = await this.request(OPENAI_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: CONNECTION_PROMPT,
        max_output_tokens: 32,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "later_gator_connection",
            schema: CONNECTION_JSON_SCHEMA,
            strict: true,
          },
        },
      }),
    });
    const payload = await readProviderResponse(response);
    const envelope = OpenAiEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new ProviderConnectionError("invalid_response", "OpenAI returned an invalid response");
    }

    const outputText = envelope.data.output
      .flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text;
    if (outputText === undefined) {
      throw new ProviderConnectionError("invalid_response", "OpenAI returned no structured output");
    }
    parseConnectionResult(outputText);
  }
}

export class AnthropicProvider implements OrganizationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async testConnection(): Promise<void> {
    const response = await this.request(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 32,
        messages: [{ role: "user", content: CONNECTION_PROMPT }],
        output_config: {
          format: {
            type: "json_schema",
            schema: CONNECTION_JSON_SCHEMA,
          },
        },
      }),
    });
    const payload = await readProviderResponse(response);
    const envelope = AnthropicEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new ProviderConnectionError(
        "invalid_response",
        "Anthropic returned an invalid response",
      );
    }

    const outputText = envelope.data.content.find((item) => item.type === "text")?.text;
    if (outputText === undefined) {
      throw new ProviderConnectionError("invalid_response", "Anthropic returned no structured output");
    }
    parseConnectionResult(outputText);
  }
}

function requireCredential(credential: string | null): string {
  if (credential === null) {
    throw new ProviderConnectionError(
      "missing_credential",
      "The selected provider credential is missing",
    );
  }
  return credential;
}

async function readProviderResponse(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
  } catch {
    throw new ProviderConnectionError("invalid_response", "Provider returned unreadable JSON");
  }
  if (!response.ok) {
    throw new ProviderConnectionError(classifyHttpStatus(response.status), "Provider request failed");
  }
  return payload;
}

function parseConnectionResult(value: unknown): void {
  let parsedValue = value;
  if (typeof value === "string") {
    try {
      parsedValue = JSON.parse(value) as unknown;
    } catch {
      throw new ProviderConnectionError("invalid_response", "Provider returned malformed JSON");
    }
  }
  if (!ConnectionResultSchema.safeParse(parsedValue).success) {
    throw new ProviderConnectionError(
      "invalid_response",
      "Provider response did not match the application schema",
    );
  }
}

function classifyHttpStatus(status: number): ProviderConnectionErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "model";
  if (status === 429) return "rate_limit";
  return "provider";
}
