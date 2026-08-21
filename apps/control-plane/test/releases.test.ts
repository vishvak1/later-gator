import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runtimeReleaseManifestSchema } from "@later-gator/contracts";
import {
  automaticRuntimeMigrations,
  fetchVerifiedReleaseFile,
  loadRuntimeRelease,
  planRuntimeMigrations,
  signedRuntimeReleaseManifest,
} from "../src/application/releases";

describe("immutable runtime releases", () => {
  it("loads generated artifacts, verifies checksums, and signs the public envelope", async () => {
    const artifact = await loadRuntimeRelease(env.RELEASE_ARTIFACTS, "1.0.0");
    expect(artifact.assets.length).toBeGreaterThan(10);
    expect(artifact.migrations.map((migration) => migration.id)).toEqual(["base-schema"]);
    const module = await fetchVerifiedReleaseFile(
      env.RELEASE_ARTIFACTS,
      artifact.mainModule.artifactPath,
      artifact.mainModule.sha256,
      15_000_000,
    );
    expect(module.byteLength).toBe(artifact.mainModule.size);

    const manifest = await signedRuntimeReleaseManifest(
      artifact,
      env.OWNER_ASSERTION_SIGNING_KEYS,
    );
    expect(runtimeReleaseManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.artifactDigest).toBe(`sha256:${artifact.artifactDigest}`);
    expect(JSON.stringify(manifest)).not.toContain("statements");
    expect(JSON.stringify(manifest)).not.toContain("artifactPath");
  });

  it("rejects an expected digest that does not match the immutable bytes", async () => {
    const artifact = await loadRuntimeRelease(env.RELEASE_ARTIFACTS, "1.0.0");
    await expect(fetchVerifiedReleaseFile(
      env.RELEASE_ARTIFACTS,
      artifact.mainModule.artifactPath,
      "0".repeat(64),
      15_000_000,
    )).rejects.toThrow("release_checksum_invalid");
  });

  it("requires a continuous schema chain and reserves destructive phases for operator workflows", async () => {
    const artifact = await loadRuntimeRelease(env.RELEASE_ARTIFACTS, "1.0.0");
    const base = artifact.migrations[0];
    if (base === undefined) throw new Error("base_migration_missing");
    const contractMigration = {
      ...base,
      id: "contract-schema",
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
      phase: "contract" as const,
    };
    const destructive = {
      ...artifact,
      maximumSchemaVersion: 2,
      migrations: [base, contractMigration],
    };
    expect(planRuntimeMigrations(destructive, 0).map(({ id }) => id)).toEqual([
      "base-schema",
      "contract-schema",
    ]);
    expect(() => automaticRuntimeMigrations(destructive, 1)).toThrow(
      "release_migration_requires_operator",
    );
    expect(() => planRuntimeMigrations({
      ...destructive,
      migrations: [contractMigration],
    }, 0)).toThrow("release_migration_gap");
  });
});
