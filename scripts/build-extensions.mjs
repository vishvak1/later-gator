// Generates browser-specific install folders from one shared extension source.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const configuredControlPlane = process.env.LATER_GATOR_CONTROL_PLANE_ORIGIN ?? "https://latergator.app";
const controlPlane = new URL(configuredControlPlane);
if (controlPlane.protocol !== "https:" || controlPlane.pathname !== "/" || controlPlane.search !== "" || controlPlane.hash !== "") {
  throw new Error("LATER_GATOR_CONTROL_PLANE_ORIGIN must be one HTTPS origin");
}
writeFileSync(
  `${outputDirectory}/config.js`,
  `"use strict";\n\nglobalThis.laterGatorExtensionConfig = Object.freeze({\n  controlPlaneOrigin: ${JSON.stringify(controlPlane.origin)},\n});\n`,
);

/** @type {unknown} */
const manifestValue = JSON.parse(readFileSync(`${outputDirectory}/manifest.json`, "utf8"));
if (
  typeof manifestValue !== "object" || manifestValue === null ||
  !("permissions" in manifestValue) || !Array.isArray(manifestValue.permissions) ||
  !manifestValue.permissions.every((permission) => typeof permission === "string")
) throw new Error("Chrome manifest permissions are invalid");
/** @type {string[]} */
const permissions = manifestValue.permissions;
for (const required of ["activeTab", "identity", "storage", "scripting", "tabs"]) {
  if (!permissions.includes(required)) throw new Error(`Missing Chrome permission: ${required}`);
}
for (const source of ["background.js", "common.js", "config.js", "popup.js"]) {
  const code = readFileSync(`${outputDirectory}/${source}`, "utf8");
  if (/\beval\s*\(|\bnew\s+Function\b|https?:\/\/[^\s"']+\.js\b/u.test(code)) {
    throw new Error(`Remote or dynamic code is forbidden in ${source}`);
  }
}

console.log("build-extensions: extension/chrome");
