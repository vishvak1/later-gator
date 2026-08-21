import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(repositoryRoot, "apps/runtime");
/** @type {unknown} */
const descriptorValue = JSON.parse(
  readFileSync(join(repositoryRoot, "releases/runtime-1.0.0.json"), "utf8"),
);
if (
  typeof descriptorValue !== "object" || descriptorValue === null ||
  !("release" in descriptorValue) || typeof descriptorValue.release !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(descriptorValue.release)
) throw new Error("Runtime release descriptor is invalid");
const release = descriptorValue.release;
const releaseRoot = join(repositoryRoot, "apps/control-plane/release-artifacts/runtime", release);

/** Returns a lowercase SHA-256 digest for immutable release verification. */
function sha256(/** @type {import("node:crypto").BinaryLike} */ bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lists files beneath one directory in stable path order. */
function filesBelow(/** @type {string} */ directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(target));
    else if (entry.isFile()) found.push(target);
  }
  return found.sort();
}

/** Splits the canonical SQLite schema without breaking trigger bodies. */
function schemaStatements(/** @type {string} */ source) {
  /** @type {string[]} */
  const statements = [];
  /** @type {string[]} */
  let current = [];
  let trigger = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("--")) continue;
    if (/^CREATE\s+TRIGGER\b/iu.test(line)) trigger = true;
    current.push(rawLine);
    const complete = trigger ? /^END;$/iu.test(line) : line.endsWith(";");
    if (!complete) continue;
    statements.push(current.join("\n"));
    current = [];
    trigger = false;
  }
  if (current.length > 0) throw new Error("schema.sql contains an incomplete statement");
  return statements;
}

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(join(releaseRoot, "assets"), { recursive: true });
mkdirSync(join(releaseRoot, "migrations"), { recursive: true });
cpSync(join(runtimeRoot, "dist/index.js"), join(releaseRoot, "runtime.mjs"));
cpSync(join(runtimeRoot, "web/public"), join(releaseRoot, "assets"), { recursive: true });
cpSync(join(runtimeRoot, "schema.sql"), join(releaseRoot, "migrations/base-schema.sql"));

const mainBytes = readFileSync(join(releaseRoot, "runtime.mjs"));
const schemaBytes = readFileSync(join(releaseRoot, "migrations/base-schema.sql"));
const assets = filesBelow(join(releaseRoot, "assets")).map((file) => {
  const bytes = readFileSync(file);
  const digest = sha256(bytes);
  return {
    path: "/" + relative(join(releaseRoot, "assets"), file).replaceAll("\\", "/"),
    artifactPath: "/release-artifacts/runtime/" + release + "/assets/" +
      relative(join(releaseRoot, "assets"), file).replaceAll("\\", "/"),
    sha256: digest,
    assetHash: digest.slice(0, 32),
    size: statSync(file).size,
  };
});
const migration = {
  id: "base-schema",
  fromSchemaVersion: 0,
  toSchemaVersion: 1,
  phase: "expand",
  artifactPath: `/release-artifacts/runtime/${release}/migrations/base-schema.sql`,
  sha256: sha256(schemaBytes),
  statements: schemaStatements(schemaBytes.toString("utf8")),
};
const artifactPayload = JSON.stringify({
  descriptor: descriptorValue,
  main: sha256(mainBytes),
  schema: sha256(schemaBytes),
  assets: assets.map(({ path, sha256: digest, size }) => ({ path, sha256: digest, size })),
  migrations: [{
    id: migration.id,
    fromSchemaVersion: migration.fromSchemaVersion,
    toSchemaVersion: migration.toSchemaVersion,
    phase: migration.phase,
    artifactPath: migration.artifactPath,
    sha256: migration.sha256,
  }],
});
const artifact = {
  ...descriptorValue,
  release,
  artifactDigest: sha256(artifactPayload),
  baseSchemaDigest: sha256(schemaBytes),
  mainModule: {
    artifactPath: `/release-artifacts/runtime/${release}/runtime.mjs`,
    sha256: sha256(mainBytes),
    size: mainBytes.byteLength,
  },
  assets,
  migrations: [migration],
};
writeFileSync(join(releaseRoot, "artifact.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log("build-runtime-release:", relative(repositoryRoot, releaseRoot), `(${String(assets.length)} assets)`);
