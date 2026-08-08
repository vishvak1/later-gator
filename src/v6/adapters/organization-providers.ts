import { z } from "zod";
import { loadProviderCredentialForWorker } from "../security/credential-vault";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

const openAiEnvelopeSchema = z.looseObject({
  output: z.array(
    z.looseObject({
      content: z
        .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
});

const anthropicEnvelopeSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

const chatCompletionSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({ content: z.string().nullish() }).optional(),
      }),
    )
    .min(1),
});

/**
 * Workers AI is moving to the OpenAI chat-completions envelope. Older models
 * answer with `{ response }`, newer ones with `{ choices: [{ message: { content } }] }`,
 * and some return both while they transition. Reading only the legacy shape
 * made capable models — gpt-oss and nemotron among them — look as though they
 * could not produce structured output, when their JSON was correct all along.
 *
 * Normalizing here keeps every caller on one shape.
 */
export function normalizeWorkersAiResult(raw: unknown): unknown {
  const legacy = z.looseObject({ response: z.unknown() }).safeParse(raw);
  if (legacy.success && legacy.data.response !== undefined && legacy.data.response !== null) {
    return { response: legacy.data.response };
  }
  const chat = chatCompletionSchema.safeParse(raw);
  const content = chat.success ? chat.data.choices[0]?.message?.content : null;
  if (typeof content === "string" && content.trim().length > 0) return { response: content };
  return raw;
}

/**
 * Workers AI reports a spent daily allowance as:
 *   "4006: you have used up your daily free allocation of 10,000 neurons…"
 *
 * The previous pattern looked for code 3036 and the words "limit" or
 * "exhausted", none of which appear. So the one error the pipeline is built to
 * handle was classified as a transient model fault: the provider never paused,
 * every queued job kept retrying against an allowance that was already gone,
 * and Settings told the owner to check their model ID.
 */
const ALLOCATION_EXHAUSTED =
  /\b(?:3036|4006)\b|daily free allocation|daily.*(?:limit|allocation)|allocation.*exhaust|neurons.*upgrade/iu;

export type ProviderName = "workers-ai" | "openai" | "anthropic";

export class OrganizationProviderError extends Error {
  constructor(
    readonly kind: "temporary" | "systemic" | "allocation",
    readonly safeCode: string,
  ) {
    super(safeCode);
    this.name = "OrganizationProviderError";
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new OrganizationProviderError("systemic", "provider_response_too_large");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new OrganizationProviderError("systemic", "provider_response_too_large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new OrganizationProviderError("systemic", "provider_response_invalid_json");
  }
}

function classifyStatus(status: number): OrganizationProviderError {
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return new OrganizationProviderError("systemic", `provider_http_${status.toString()}`);
  }
  if (status === 429 || status >= 500) {
    return new OrganizationProviderError("temporary", `provider_http_${status.toString()}`);
  }
  return new OrganizationProviderError("systemic", `provider_http_${status.toString()}`);
}

async function externalJson(
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new OrganizationProviderError("temporary", "provider_network");
  }
  if (!response.ok) throw classifyStatus(response.status);
  return boundedJson(response);
}

/**
 * Prepaid AI Gateway credits only apply to traffic routed through a gateway,
 * so the id has to travel with every Workers AI call. Absent, calls go direct
 * and draw on the free daily allocation exactly as before.
 */
export function aiGatewayOptions(gatewayId: string | null): { gateway: { id: string } } | undefined {
  return gatewayId === null || gatewayId.trim() === ""
    ? undefined
    : { gateway: { id: gatewayId.trim() } };
}

export async function runOrganizationProvider(
  env: Env,
  provider: ProviderName,
  model: string,
  prompt: string,
  jsonSchema: object,
  gatewayId: string | null = null,
): Promise<unknown> {
  if (provider === "workers-ai") {
    try {
      return normalizeWorkersAiResult(await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: jsonSchema },
        // Reasoning models spend part of the budget before emitting the object.
        max_tokens: 2048,
        // Near-greedy decoding made the model copy tags straight out of the
        // registry it was shown. The JSON schema, not the temperature, is what
        // keeps the response well formed.
        temperature: 0.4,
      }, aiGatewayOptions(gatewayId)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (ALLOCATION_EXHAUSTED.test(message)) {
        throw new OrganizationProviderError("allocation", "workers_ai_allocation_exhausted");
      }
      throw new OrganizationProviderError("temporary", "workers_ai_temporary");
    }
  }

  const credential = await loadProviderCredentialForWorker(env, provider);
  if (credential === null) {
    throw new OrganizationProviderError("systemic", "missing_provider_credential");
  }

  if (provider === "openai") {
    const payload = await externalJson(OPENAI_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: 1024,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "later_gator_organization",
            schema: jsonSchema,
            strict: true,
          },
        },
      }),
    });
    const parsed = openAiEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new OrganizationProviderError("systemic", "provider_response_schema");
    }
    const text = parsed.data.output
      .flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text;
    if (text === undefined) {
      throw new OrganizationProviderError("systemic", "provider_output_missing");
    }
    return { response: text };
  }

  const payload = await externalJson(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": credential,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema: jsonSchema } },
    }),
  });
  const parsed = anthropicEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OrganizationProviderError("systemic", "provider_response_schema");
  }
  const text = parsed.data.content.find((item) => item.type === "text")?.text;
  if (text === undefined) {
    throw new OrganizationProviderError("systemic", "provider_output_missing");
  }
  return { response: text };
}

const connectionSchema = {
  type: "object",
  properties: { ok: { type: "string", enum: ["later-gator"] } },
  required: ["ok"],
  additionalProperties: false,
} as const;

const connectionResultSchema = z.strictObject({ ok: z.literal("later-gator") });

export async function testProviderConnection(
  env: Env,
  provider: ProviderName,
  model: string,
  gatewayId: string | null = null,
): Promise<void> {
  const result = await runOrganizationProvider(
    env,
    provider,
    model,
    'Return exactly {"ok":"later-gator"} as the requested JSON.',
    connectionSchema,
    gatewayId,
  );
  const envelope = z.looseObject({ response: z.unknown() }).safeParse(result);
  if (!envelope.success) {
    throw new OrganizationProviderError("systemic", "provider_test_invalid");
  }
  let value = envelope.data.response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new OrganizationProviderError("systemic", "provider_test_invalid");
    }
  }
  if (!connectionResultSchema.safeParse(value).success) {
    throw new OrganizationProviderError("systemic", "provider_test_invalid");
  }
}
