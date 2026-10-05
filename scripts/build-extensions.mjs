// Generates browser-specific install folders from one shared extension source.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(REPOSITORY_ROOT);

const sourceDirectory = "apps/chrome-extension/src";
const iconDirectory = "apps/chrome-extension/assets/icons";
const outputDirectory = "extension/chrome";

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
cpSync(sourceDirectory, outputDirectory, { recursive: true });
cpSync(iconDirectory, `${outputDirectory}/icons`, { recursive: true });
cpSync("apps/chrome-extension/manifest.json", `${outputDirectory}/manifest.json`);

/** @type {unknown} */
const manifestValue = JSON.parse(readFileSync(`${outputDirectory}/manifest.json`, "utf8"));
if (
  typeof manifestValue !== "object" || manifestValue === null ||
  !("permissions" in manifestValue) || !Array.isArray(manifestValue.permissions) ||
  !manifestValue.permissions.every((permission) => typeof permission === "string")
) throw new Error("Chrome manifest permissions are invalid");
/** @type {string[]} */
const permissions = manifestValue.permissions;
for (const required of ["activeTab", "storage", "scripting", "tabs"]) {
  if (!permissions.includes(required)) throw new Error(`Missing Chrome permission: ${required}`);
}
for (const source of ["background.js", "common.js", "popup.js"]) {
  const code = readFileSync(`${outputDirectory}/${source}`, "utf8");
  if (/\beval\s*\(|\bnew\s+Function\b|https?:\/\/[^\s"']+\.js\b/u.test(code)) {
    throw new Error(`Remote or dynamic code is forbidden in ${source}`);
  }
}

console.log("build-extensions: extension/chrome");
