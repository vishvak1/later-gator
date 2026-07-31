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

export async function runOrganizationProvider(
  env: Env,
  provider: ProviderName,
  model: string,
  prompt: string,
  jsonSchema: object,
): Promise<unknown> {
  if (provider === "workers-ai") {
    try {
      return await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: jsonSchema },
        max_tokens: 1024,
        temperature: 0.1,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/\b3036\b|daily.*limit|allocation.*exhaust/iu.test(message)) {
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
): Promise<void> {
  const result = await runOrganizationProvider(
    env,
    provider,
    model,
    'Return exactly {"ok":"later-gator"} as the requested JSON.',
    connectionSchema,
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
