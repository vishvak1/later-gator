import { z } from "zod";
import {
  base64UrlSchema,
  contractVersionSchema,
  isoTimestampSchema,
  semverSchema,
} from "./primitives";

export const modelProviderSchema = z.enum(["cloudflare", "openai", "anthropic"]);

export const supportedModelSchema = z
  .object({
    provider: modelProviderSchema,
    modelId: z.string().min(1).max(160),
    displayName: z.string().min(1).max(120),
    capabilities: z.array(z.enum(["organization", "structured_output"])).min(1).max(2),
    isDefault: z.boolean(),
    deprecatedAfter: isoTimestampSchema.nullable(),
    minimumRuntimeRelease: semverSchema,
  })
  .strict();

export const modelCatalogSchema = z
  .object({
    contractVersion: contractVersionSchema,
    revision: z.number().int().positive(),
    publishedAt: isoTimestampSchema,
    models: z.array(supportedModelSchema).min(1).max(100),
    signingKeyId: z.string().min(1).max(128),
    signature: base64UrlSchema,
  })
  .strict();

export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
