import {
  modelCatalogSchema,
  storagePlanCatalogSchema,
  type ModelCatalog,
  type StoragePlanCatalog,
} from "@later-gator/contracts";
import {
  parseOwnerAssertionKeyRing,
  signPublicCatalog,
} from "../security/owner-assertions";

const PUBLISHED_AT = "2026-08-21T00:00:00.000Z";
const REVIEWED_ON = "2026-08-21";

const MODEL_CATALOG_UNSIGNED = {
  contractVersion: 1,
  revision: 1,
  publishedAt: PUBLISHED_AT,
  models: [
    {
      provider: "cloudflare",
      modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      displayName: "Llama 3.3 70B Instruct (fast)",
      capabilities: ["organization", "structured_output"],
      isDefault: true,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    },
    {
      provider: "cloudflare",
      modelId: "@cf/zai-org/glm-4.7-flash",
      displayName: "GLM 4.7 Flash",
      capabilities: ["organization", "structured_output"],
      isDefault: false,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    },
    {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      capabilities: ["organization", "structured_output"],
      isDefault: true,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    },
    {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      displayName: "GPT-5.4 mini",
      capabilities: ["organization", "structured_output"],
      isDefault: false,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    },
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      displayName: "Claude Sonnet 4",
      capabilities: ["organization", "structured_output"],
      isDefault: true,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    },
    {
      provider: "anthropic",
      modelId: "claude-opus-4-1-20250805",
      displayName: "Claude Opus 4.1",
      capabilities: ["organization", "structured_output"],
      isDefault: false,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    },
  ],
} as const;

const STORAGE_CATALOG_UNSIGNED = {
  contractVersion: 1,
  revision: 1,
  reviewedOn: REVIEWED_ON,
  disclaimer:
    "Cloudflare allowances are account-shared, may change, and are informational rather than Later Gator entitlements.",
  plans: [
    {
      storageVariant: "kv",
      title: "Workers KV",
      summary: "No billing profile is normally needed on the Workers Free plan. Thumbnail writes pause if an account limit is reached.",
      billingProfileMayBeRequired: false,
      informationalAllowances: [
        "1 GB stored data on the Workers Free plan",
        "100,000 reads and 1,000 writes per day on the Workers Free plan",
      ],
      officialUrls: [
        "https://developers.cloudflare.com/kv/platform/pricing/",
        "https://developers.cloudflare.com/kv/platform/limits/",
      ],
    },
    {
      storageVariant: "r2",
      title: "R2 Standard",
      summary: "R2 requires subscription activation and may require a billing profile, even when usage remains inside included amounts.",
      billingProfileMayBeRequired: true,
      informationalAllowances: [
        "10 GB-month storage per month in the free tier",
        "1 million Class A and 10 million Class B operations per month in the free tier",
      ],
      officialUrls: ["https://developers.cloudflare.com/r2/pricing/"],
    },
    {
      storageVariant: "disabled",
      title: "No thumbnails",
      summary: "Bookmarks, search, and AI organization continue without storing thumbnail objects.",
      billingProfileMayBeRequired: false,
      informationalAllowances: [],
      officialUrls: ["https://developers.cloudflare.com/workers/"],
    },
  ],
} as const;

/** Builds the signed, release-owned model catalog without reading owner data. */
export async function publicModelCatalog(signingKeys: string): Promise<ModelCatalog> {
  const ring = parseOwnerAssertionKeyRing(signingKeys);
  const unsigned = { ...MODEL_CATALOG_UNSIGNED, signingKeyId: ring.activeKid };
  const signed = await signPublicCatalog(ring, "model-catalog", unsigned);
  return modelCatalogSchema.parse({ ...unsigned, ...signed });
}

/** Builds the signed, dated storage-plan catalog without reading owner data. */
export async function publicStoragePlanCatalog(
  signingKeys: string,
): Promise<StoragePlanCatalog> {
  const ring = parseOwnerAssertionKeyRing(signingKeys);
  const unsigned = { ...STORAGE_CATALOG_UNSIGNED, signingKeyId: ring.activeKid };
  const signed = await signPublicCatalog(ring, "storage-plan-catalog", unsigned);
  return storagePlanCatalogSchema.parse({ ...unsigned, ...signed });
}
