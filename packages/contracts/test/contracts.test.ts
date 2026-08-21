import { describe, expect, it } from "vitest";
import {
  installationRecordSchema,
  modelCatalogSchema,
  ownerAssertionPayloadSchema,
  runtimeReleaseManifestSchema,
  storagePlanCatalogSchema,
  systemHealthSchema,
} from "../src";

describe("managed BYOC contracts", () => {
  it("accepts a bounded owner assertion and rejects private extras", () => {
    const assertion = {
      contractVersion: 1,
      issuer: "https://latergator.app",
      audience: "installation_123",
      subject: "cloudflare-subject",
      installationId: "installation_123",
      nonce: "abcdefghijklmnopqrstuvwxyz_123456",
      jti: "assertion_123",
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    };
    expect(ownerAssertionPayloadSchema.parse(assertion)).toEqual(assertion);
    expect(
      ownerAssertionPayloadSchema.safeParse({ ...assertion, providerApiKey: "must-not-cross" }).success,
    ).toBe(false);
  });

  it("keeps installation metadata free of bookmark and provider configuration", () => {
    const installation = {
      contractVersion: 1,
      installationId: "installation_123",
      accountId: "account_123",
      workerName: "later-gator-owner-123",
      workerUrl: "https://later-gator-owner-123.example.workers.dev",
      storageVariant: "kv",
      state: "ready",
      installedRelease: "1.0.0",
      desiredRelease: "1.0.0",
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:00.000Z",
    };
    expect(installationRecordSchema.parse(installation)).toEqual(installation);
    expect(
      installationRecordSchema.safeParse({ ...installation, bookmarkUrl: "https://private.test" })
        .success,
    ).toBe(false);
    expect(
      installationRecordSchema.safeParse({ ...installation, selectedProvider: "openai" }).success,
    ).toBe(false);
  });

  it("validates signed public model metadata without user configuration", () => {
    const catalog = {
      contractVersion: 1,
      revision: 1,
      publishedAt: "2026-08-19T12:00:00.000Z",
      models: [
        {
          provider: "cloudflare",
          modelId: "@cf/meta/example",
          displayName: "Example model",
          capabilities: ["organization"],
          isDefault: true,
          deprecatedAfter: null,
          minimumRuntimeRelease: "1.0.0",
        },
      ],
      signingKeyId: "catalog-key-1",
      signature: "abcdefghijklmnopqrstuvwxyz_123456",
    };
    expect(modelCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(modelCatalogSchema.safeParse({ ...catalog, activeModel: "user-choice" }).success).toBe(false);
  });

  it("validates informational storage-plan copy for all three modes", () => {
    const catalog = {
      contractVersion: 1,
      revision: 1,
      reviewedOn: "2026-08-19",
      disclaimer: "Cloudflare may change plan limits and billing requirements.",
      plans: ["kv", "r2", "disabled"].map((storageVariant) => ({
        storageVariant,
        title: storageVariant.toUpperCase(),
        summary: "Informational setup choice.",
        billingProfileMayBeRequired: storageVariant === "r2",
        informationalAllowances: [],
        officialUrls: ["https://developers.cloudflare.com/"],
      })),
      signingKeyId: "catalog-key-1",
      signature: "abcdefghijklmnopqrstuvwxyz_123456",
    };
    expect(storagePlanCatalogSchema.parse(catalog)).toEqual(catalog);
  });

  it("requires coherent release and privacy-safe health metadata", () => {
    const manifest = {
      contractVersion: 1,
      release: "1.1.0",
      publishedAt: "2026-08-19T12:00:00.000Z",
      compatibilityDate: "2026-08-19",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      baseSchemaDigest: `sha256:${"b".repeat(64)}`,
      minimumSchemaVersion: 1,
      maximumSchemaVersion: 2,
      requiredBindings: ["d1", "ai"],
      optionalBindings: ["kv", "r2"],
      healthContractVersion: 1,
      signingKeyId: "release-key-1",
      signature: "abcdefghijklmnopqrstuvwxyz_123456",
    };
    expect(runtimeReleaseManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      systemHealthSchema.parse({
        contractVersion: 1,
        runtimeRelease: "1.1.0",
        schemaVersion: 2,
        status: "ready",
        bindingReadiness: "ready",
        queueReadiness: "ready",
        safeErrorCodes: [],
      }),
    ).toMatchObject({ status: "ready" });
  });
});
