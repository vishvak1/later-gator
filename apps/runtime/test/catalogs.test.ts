import { env } from "cloudflare:workers";
import {
  catalogSigningBytes,
  type SignedCatalogKind,
} from "@later-gator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readPublicCatalogState,
  refreshPublicCatalogs,
} from "../src/application/catalogs";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const KEY_ID = "catalog-test-key";

/** Encodes test signature bytes in the catalog's base64url representation. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Signs a test catalog using the same purpose-separated contract as production. */
async function signCatalog(
  key: CryptoKey,
  kind: SignedCatalogKind,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    catalogSigningBytes(kind, value),
  );
  return { ...value, signature: base64Url(new Uint8Array(signature)) };
}

/** Builds one internally consistent signed catalog fixture pair. */
async function catalogFixture(revision = 1, publishedAt = NOW.toISOString()) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const models = await signCatalog(pair.privateKey, "model-catalog", {
    contractVersion: 1,
    revision,
    publishedAt,
    models: [{
      provider: "openai",
      modelId: "gpt-test",
      displayName: "GPT Test",
      capabilities: ["organization", "structured_output"],
      isDefault: true,
      deprecatedAfter: null,
      minimumRuntimeRelease: "1.0.0",
    }],
    signingKeyId: KEY_ID,
  });
  const plans = await signCatalog(pair.privateKey, "storage-plan-catalog", {
    contractVersion: 1,
    revision,
    reviewedOn: publishedAt.slice(0, 10),
    disclaimer: "Informational account-shared allowances may change.",
    plans: ["kv", "r2", "disabled"].map((storageVariant) => ({
      storageVariant,
      title: storageVariant.toUpperCase(),
      summary: "Informational storage choice.",
      billingProfileMayBeRequired: storageVariant === "r2",
      informationalAllowances: [],
      officialUrls: ["https://developers.cloudflare.com/"],
    })),
    signingKeyId: KEY_ID,
  });
  return {
    jwks: {
      keys: [{
        alg: "ES256",
        crv: "P-256",
        kid: KEY_ID,
        kty: "EC",
        use: "sig",
        x: publicJwk.x,
        y: publicJwk.y,
      }],
    },
    models,
    plans,
    privateKey: pair.privateKey,
  };
}

/** Creates a bounded fetch implementation for the three public catalog resources. */
function catalogFetch(fixture: Awaited<ReturnType<typeof catalogFixture>>): typeof fetch {
  const fetcher = (input: RequestInfo | URL): Promise<Response> => {
    const address = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const path = new URL(address).pathname;
    if (path.endsWith("later-gator-jwks.json")) return Promise.resolve(Response.json(fixture.jwks));
    if (path === "/catalogs/models") return Promise.resolve(Response.json(fixture.models));
    if (path === "/catalogs/storage-plans") return Promise.resolve(Response.json(fixture.plans));
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return fetcher;
}

describe("signed public catalogs", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM public_catalog_cache"),
      env.DB.prepare("UPDATE public_catalog_status SET last_checked_at = NULL, last_safe_error_code = NULL"),
      env.DB.prepare(
        "UPDATE provider_settings SET provider = 'workers-ai', model = '@cf/local-choice' WHERE id = 1",
      ),
    ]);
  });

  it("accepts signed catalogs without changing the active local provider or model", async () => {
    const fixture = await catalogFixture();
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(fixture), NOW);
    const state = await readPublicCatalogState(env.DB);
    expect(state.models?.revision).toBe(1);
    expect(state.storagePlans?.reviewedOn).toBe("2026-08-21");
    expect(state.status.models.safeErrorCode).toBeNull();
    expect(
      await env.DB.prepare("SELECT provider, model FROM provider_settings WHERE id = 1").first(),
    ).toEqual({ provider: "workers-ai", model: "@cf/local-choice" });
  });

  it("retains the last valid cache after signature, replay, schema, and stale failures", async () => {
    const valid = await catalogFixture(2);
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(valid), NOW);

    const tampered = {
      ...valid,
      models: { ...valid.models, revision: 3, models: [] },
    };
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(tampered), NOW);
    let state = await readPublicCatalogState(env.DB);
    expect(state.models?.revision).toBe(2);
    expect(state.status.models.safeErrorCode).toBe("catalog_invalid");

    const replay = await catalogFixture(1);
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(replay), NOW);
    state = await readPublicCatalogState(env.DB);
    expect(state.models?.revision).toBe(2);
    expect(state.status.models.safeErrorCode).toBe("catalog_replayed");

    const stale = await catalogFixture(3, "2025-01-01T00:00:00.000Z");
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(stale), NOW);
    state = await readPublicCatalogState(env.DB);
    expect(state.models?.revision).toBe(2);
    expect(state.status.models.safeErrorCode).toBe("catalog_stale");
  });

  it("rejects a well-shaped catalog whose signed content was changed", async () => {
    const valid = await catalogFixture();
    const tampered = {
      ...valid,
      models: {
        ...valid.models,
        models: [{
          provider: "openai",
          modelId: "changed-after-signing",
          displayName: "Changed",
          capabilities: ["organization", "structured_output"],
          isDefault: true,
          deprecatedAfter: null,
          minimumRuntimeRelease: "1.0.0",
        }],
      },
    };
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(tampered), NOW);
    const state = await readPublicCatalogState(env.DB);
    expect(state.models).toBeNull();
    expect(state.status.models.safeErrorCode).toBe("catalog_signature_invalid");
  });

  it("retains both last-valid catalogs when their public endpoints are unavailable", async () => {
    const valid = await catalogFixture(4);
    await refreshPublicCatalogs(env.DB, "https://control-plane.test", catalogFetch(valid), NOW);
    const unavailable = (input: RequestInfo | URL): Promise<Response> => {
      const address = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (new URL(address).pathname.endsWith("later-gator-jwks.json")) {
        return Promise.resolve(Response.json(valid.jwks));
      }
      return Promise.reject(new TypeError("public catalog unavailable"));
    };

    await refreshPublicCatalogs(env.DB, "https://control-plane.test", unavailable, NOW);

    const state = await readPublicCatalogState(env.DB);
    expect(state.models?.revision).toBe(4);
    expect(state.storagePlans?.revision).toBe(4);
    expect(state.status.models.safeErrorCode).toBe("catalog_network");
    expect(state.status["storage-plans"].safeErrorCode).toBe("catalog_network");
    expect(
      await env.DB.prepare("SELECT provider, model FROM provider_settings WHERE id = 1").first(),
    ).toEqual({ provider: "workers-ai", model: "@cf/local-choice" });
  });
});
