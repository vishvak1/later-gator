// Generates browser-specific install folders from one shared extension source.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const browsers = ["chrome", "firefox"];

for (const browser of browsers) {
  const outputDirectory = `extension/${browser}`;
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  cpSync("extension/shared", outputDirectory, { recursive: true });
  cpSync(`extension/manifests/${browser}.json`, `${outputDirectory}/manifest.json`);
}

console.log("build-extensions: extension/chrome, extension/firefox");
