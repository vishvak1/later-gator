import { z } from "zod";
import {
  OrganizationResultSchema,
  type OrganizationResult,
  type ProviderChoice,
} from "../domain/schemas";
import { readBoundedJsonResponse } from "./bounded-json-response";

const MAX_RESPONSE_BYTES = 512_000;
const MAX_PROMPT_CHARACTERS = 60_000;
const OPENAI_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ORGANIZATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
    description: { type: "string", minLength: 1, maxLength: 1000 },
    folder: {
      type: "string",
      enum: [
        "Social Posts",
        "Articles",
        "Videos & Talks",
        "Code",
        "Docs & Reference",
        "Papers",
        "Websites & Apps",
      ],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: ["string", "null"], maxLength: 1000 },
  },
  required: ["tags", "description", "folder", "confidence", "notes"],
  additionalProperties: false,
} as const;

const WorkersEnvelopeSchema = z.looseObject({ response: z.unknown() });
const OpenAiEnvelopeSchema = z.looseObject({
  output: z.array(
    z.looseObject({
      content: z
        .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
});
const AnthropicEnvelopeSchema = z.looseObject({
  content: z.array(
    z.looseObject({ type: z.string(), text: z.string().optional() }),
  ),
});

export interface OrganizationInput {
  title: string;
  excerpt: string;
  link: string;
  registry: { name: string; count: number }[];
  personalInstructions: string;
  fullPromptOverride?: string | null;
  correction: string | null;
}

export interface Organizer {
  organize(input: OrganizationInput): Promise<OrganizationResult>;
}

export type OrganizerErrorKind = "transient" | "systemic" | "schema";

export class OrganizerError extends Error {
  override readonly name = "OrganizerError";

  constructor(
    readonly kind: OrganizerErrorKind,
    readonly code: string,
    message: string,
    readonly retryAt: string | null = null,
  ) {
    super(message);
  }
}

export function createOrganizer(
  choice: ProviderChoice,
  dependencies: {
    ai: Ai;
    credential: string | null;
    request?: typeof fetch;
  },
): Organizer {
  switch (choice.provider) {
    case "workers-ai":
      return new WorkersAiOrganizer(
        (model, input) => dependencies.ai.run(model, input),
        choice.model,
      );
    case "openai":
      return new OpenAiOrganizer(
        requireCredential(dependencies.credential),
        choice.model,
        dependencies.request,
      );
    case "anthropic":
      return new AnthropicOrganizer(
        requireCredential(dependencies.credential),
        choice.model,
        dependencies.request,
      );
  }
}

export class WorkersAiOrganizer implements Organizer {
  constructor(
    private readonly run: (
      model: string,
      input: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly model: string,
  ) {}

  async organize(input: OrganizationInput): Promise<OrganizationResult> {
    const prompt = buildPrompt(input);
    let response: unknown;
    try {
      response = await this.run(this.model, {
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_object",
        },
        max_tokens: 700,
        temperature: 0.1,
      });
    } catch {
      throw new OrganizerError("transient", "workers_ai_failure", "Workers AI failed");
    }
    const envelope = WorkersEnvelopeSchema.safeParse(response);
    if (!envelope.success) throw schemaError();
    return parseResult(envelope.data.response);
  }
}

export class OpenAiOrganizer implements Organizer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async organize(input: OrganizationInput): Promise<OrganizationResult> {
    const payload = await externalCall(
      this.request,
      OPENAI_URL,
      {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      {
        model: this.model,
        input: buildPrompt(input),
        max_output_tokens: 700,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "later_gator_organization",
            schema: ORGANIZATION_JSON_SCHEMA,
            strict: true,
          },
        },
      },
    );
    const envelope = OpenAiEnvelopeSchema.safeParse(payload);
    if (!envelope.success) throw schemaError();
    const text = envelope.data.output
      .flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text;
    if (text === undefined) throw schemaError();
    return parseResult(text);
  }
}

export class AnthropicOrganizer implements Organizer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async organize(input: OrganizationInput): Promise<OrganizationResult> {
    const payload = await externalCall(
      this.request,
      ANTHROPIC_URL,
      {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      {
        model: this.model,
        max_tokens: 700,
        messages: [{ role: "user", content: buildPrompt(input) }],
        output_config: {
          format: {
            type: "json_schema",
            schema: ORGANIZATION_JSON_SCHEMA,
          },
        },
      },
    );
    const envelope = AnthropicEnvelopeSchema.safeParse(payload);
    if (!envelope.success) throw schemaError();
    const text = envelope.data.content.find((item) => item.type === "text")?.text;
    if (text === undefined) throw schemaError();
    return parseResult(text);
  }
}

function buildPrompt(input: OrganizationInput): string {
  const registry = input.registry
    .map((tag) => `${tag.name}:${tag.count.toString()}`)
    .join(",");
  const prompt = [
    input.fullPromptOverride ??
      [
        "Organize this saved bookmark.",
        "Folders classify source type. Tags classify topic.",
        "Reuse registry tags before inventing concise one- or two-word tags.",
        "Example: GitHub repository -> Code; tags describe its technology and topic.",
        "Example: arXiv paper -> Papers; do not use the folder name as a tag.",
        "Example: low confidence -> keep the best tags and mark confidence low.",
        'Return only one JSON object with exactly these fields: {"tags":["topic"],"description":"concise description","folder":"Social Posts | Articles | Videos & Talks | Code | Docs & Reference | Papers | Websites & Apps","confidence":"high | medium | low","notes":null}.',
        "Use null for notes unless a low-confidence decision needs a short explanation.",
      ].join("\n"),
    `Title: ${input.title.slice(0, 1_000)}`,
    `Excerpt: ${input.excerpt.slice(0, 10_000)}`,
    `URL: ${input.link.slice(0, 2_048)}`,
    `Registry: ${registry}`,
    input.personalInstructions.length > 0
      ? `Personal instructions: ${input.personalInstructions}`
      : "",
    input.correction === null ? "" : `Previous validation correction: ${input.correction}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  if (prompt.length > MAX_PROMPT_CHARACTERS) {
    throw new OrganizerError(
      "systemic",
      "registry_context_limit",
      "The full organization context exceeds the safe prompt budget",
    );
  }
  return prompt;
}

function parseResult(value: unknown): OrganizationResult {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw schemaError();
    }
  }
  const result = OrganizationResultSchema.safeParse(parsed);
  if (!result.success) throw schemaError();
  return result.data;
}

async function externalCall(
  request: typeof fetch,
  url: string,
  headers: HeadersInit,
  body: object,
): Promise<unknown> {
  let response: Response;
  try {
    response = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new OrganizerError("transient", "network", "Provider network request failed");
  }

  let payload: unknown;
  try {
    payload = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
  } catch {
    if (!response.ok) throw classifyStatus(response);
    throw schemaError();
  }
  if (!response.ok) throw classifyStatus(response);
  return payload;
}

function classifyStatus(response: Response): OrganizerError {
  const status = response.status;
  if (status === 401 || status === 403 || status === 404 || status === 402) {
    return new OrganizerError("systemic", `http_${status.toString()}`, "Provider access failed");
  }
  return new OrganizerError(
    "transient",
    `http_${status.toString()}`,
    "Provider request failed transiently",
    retryAt(response),
  );
}

function retryAt(response: Response): string | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.now() + seconds * 1_000).toISOString();
  }
  const date = new Date(retryAfter);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireCredential(value: string | null): string {
  if (value === null) {
    throw new OrganizerError("systemic", "missing_credential", "Provider credential is missing");
  }
  return value;
}

function schemaError(): OrganizerError {
  return new OrganizerError("schema", "invalid_schema", "Provider output was invalid");
}
