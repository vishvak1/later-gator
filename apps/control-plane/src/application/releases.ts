import {
  runtimeReleaseManifestSchema,
  type RuntimeReleaseManifest,
} from "@later-gator/contracts";
import { z } from "zod";
import {
  parseOwnerAssertionKeyRing,
  signRuntimeRelease,
} from "../security/owner-assertions";

const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactPathSchema = z.string().min(2).max(1024).regex(/^\/release-artifacts\//u);
const releaseAssetSchema = z.object({
  path: z.string().min(1).max(1024).regex(/^\//u),
  artifactPath: artifactPathSchema,
  sha256: hexDigestSchema,
  assetHash: z.string().regex(/^[a-f0-9]{32}$/u),
  size: z.number().int().nonnegative().max(25_000_000),
}).strict();
const releaseMigrationSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/u),
  fromSchemaVersion: z.number().int().nonnegative(),
  toSchemaVersion: z.number().int().positive(),
  phase: z.enum(["expand", "migrate", "contract"]),
  artifactPath: artifactPathSchema,
  sha256: hexDigestSchema,
  statements: z.array(z.string().min(1).max(100_000)).min(1).max(500),
}).strict().refine((migration) => migration.toSchemaVersion > migration.fromSchemaVersion);

export const runtimeReleaseArtifactSchema = z.object({
  contractVersion: z.literal(1),
  release: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  publishedAt: z.iso.datetime({ offset: true }),
  compatibilityDate: z.iso.date(),
  minimumSchemaVersion: z.number().int().nonnegative(),
  maximumSchemaVersion: z.number().int().nonnegative(),
  healthContractVersion: z.number().int().positive(),
  requiredBindings: z.array(z.string().min(1).max(64)).min(1).max(20),
  optionalBindings: z.array(z.string().min(1).max(64)).max(20),
  artifactDigest: hexDigestSchema,
  baseSchemaDigest: hexDigestSchema,
  mainModule: z.object({
    artifactPath: artifactPathSchema,
    sha256: hexDigestSchema,
    size: z.number().int().positive().max(15_000_000),
  }).strict(),
  assets: z.array(releaseAssetSchema).min(1).max(20_000),
  migrations: z.array(releaseMigrationSchema).min(1).max(100),
}).strict();

export type RuntimeReleaseArtifact = z.infer<typeof runtimeReleaseArtifactSchema>;

/** Returns the continuous migration chain required to reach an artifact's exact schema. */
export function planRuntimeMigrations(
  artifact: RuntimeReleaseArtifact,
  installedSchemaVersion: number,
): RuntimeReleaseArtifact["migrations"] {
  if (
    !Number.isInteger(installedSchemaVersion) ||
    installedSchemaVersion < 0 ||
    installedSchemaVersion > artifact.maximumSchemaVersion
  ) throw new Error("release_schema_incompatible");
  let current = installedSchemaVersion;
  const planned: RuntimeReleaseArtifact["migrations"] = [];
  for (const migration of artifact.migrations) {
    if (migration.toSchemaVersion <= current) continue;
    if (migration.fromSchemaVersion !== current) throw new Error("release_migration_gap");
    planned.push(migration);
    current = migration.toSchemaVersion;
  }
  if (current !== artifact.maximumSchemaVersion) throw new Error("release_migration_gap");
  return planned;
}

/** Allows unattended updates only while every pending schema change is rollback-compatible. */
export function automaticRuntimeMigrations(
  artifact: RuntimeReleaseArtifact,
  installedSchemaVersion: number,
): RuntimeReleaseArtifact["migrations"] {
  const planned = planRuntimeMigrations(artifact, installedSchemaVersion);
  if (planned.some((migration) => migration.phase !== "expand")) {
    throw new Error("release_migration_requires_operator");
  }
  return planned;
}

/** Hashes an artifact response using the release's required SHA-256 algorithm. */
export async function releaseArtifactDigest(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Loads one immutable descriptor from the private control-plane assets binding. */
export async function loadRuntimeRelease(
  artifacts: Fetcher,
  release = "1.0.0",
): Promise<RuntimeReleaseArtifact> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release)) {
    throw new Error("release_invalid");
  }
  const response = await artifacts.fetch(
    `https://release-artifacts.invalid/runtime/${release}/artifact.json`,
  );
  if (!response.ok) throw new Error("release_unavailable");
  return runtimeReleaseArtifactSchema.parse(await response.json());
}

/** Fetches and checksum-verifies one release file before it can reach Cloudflare. */
export async function fetchVerifiedReleaseFile(
  artifacts: Fetcher,
  artifactPath: string,
  expectedDigest: string,
  maximumBytes: number,
): Promise<ArrayBuffer> {
  const validatedPath = artifactPathSchema.parse(artifactPath)
    .replace(/^\/release-artifacts/u, "");
  const response = await artifacts.fetch(`https://release-artifacts.invalid${validatedPath}`);
  if (!response.ok) throw new Error("release_unavailable");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maximumBytes) throw new Error("release_file_too_large");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new Error("release_file_too_large");
  if (await releaseArtifactDigest(bytes) !== expectedDigest) {
    throw new Error("release_checksum_invalid");
  }
  return bytes;
}

/** Publishes the signed public compatibility envelope for one immutable artifact. */
export async function signedRuntimeReleaseManifest(
  artifact: RuntimeReleaseArtifact,
  signingKeys: string,
): Promise<RuntimeReleaseManifest> {
  const ring = parseOwnerAssertionKeyRing(signingKeys);
  const unsigned = {
    contractVersion: artifact.contractVersion,
    release: artifact.release,
    publishedAt: artifact.publishedAt,
    compatibilityDate: artifact.compatibilityDate,
    artifactDigest: `sha256:${artifact.artifactDigest}`,
    baseSchemaDigest: `sha256:${artifact.baseSchemaDigest}`,
    minimumSchemaVersion: artifact.minimumSchemaVersion,
    maximumSchemaVersion: artifact.maximumSchemaVersion,
    requiredBindings: artifact.requiredBindings,
    optionalBindings: artifact.optionalBindings,
    healthContractVersion: artifact.healthContractVersion,
    signingKeyId: ring.activeKid,
  };
  const signature = await signRuntimeRelease(ring, unsigned);
  return runtimeReleaseManifestSchema.parse({ ...unsigned, ...signature });
}
