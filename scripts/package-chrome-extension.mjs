import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repositoryRoot);

/** @type {unknown} */
const manifestValue = JSON.parse(readFileSync("apps/chrome-extension/manifest.json", "utf8"));
if (
  typeof manifestValue !== "object" || manifestValue === null ||
  !("version" in manifestValue) || typeof manifestValue.version !== "string" ||
  !/^\d+\.\d+\.\d+$/u.test(manifestValue.version)
) throw new Error("Chrome manifest version is invalid");
const version = manifestValue.version;
const outputDirectory = "apps/chrome-extension/dist";
const archive = join(repositoryRoot, outputDirectory, `later-gator-chrome-${version}.zip`);
mkdirSync(outputDirectory, { recursive: true });
rmSync(archive, { force: true });
execFileSync("zip", ["-q", "-r", archive, "."], {
  cwd: join(repositoryRoot, "extension/chrome"),
  stdio: "inherit",
});
console.log(`package-chrome-extension: ${archive}`);
