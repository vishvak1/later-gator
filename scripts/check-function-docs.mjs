/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
// Enforces documentation for named production functions without demanding
// comments on short anonymous callbacks such as map and event handlers.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = [
  "apps/runtime/src",
  "apps/control-plane/src",
  "packages/contracts/src",
  "apps/runtime/web/src",
  "apps/chrome-extension/src",
  "scripts",
];

/** Returns the stable name of a function-like syntax node, when it has one. */
function functionName(node, sourceFile) {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText(sourceFile);
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return null;
}

/** Returns the node whose leading comments document a named function. */
function documentationAnchor(node) {
  return ts.isVariableDeclaration(node) ? node.parent.parent : node;
}

/** Returns whether an anchor has a leading JSDoc block. */
function hasDocumentation(text, anchor, sourceFile) {
  const leadingText = text.slice(anchor.getFullStart(), anchor.getStart(sourceFile));
  return /\/\*\*[\s\S]*?\*\//u.test(leadingText);
}

/**
 * Lists supported source files recursively when ripgrep is unavailable.
 * @returns {string[]}
 */
function fallbackSourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...fallbackSourceFiles(target));
    else if (entry.isFile() && /\.(?:[cm]?js|ts)$/u.test(entry.name)) {
      found.push(relative(REPOSITORY_ROOT, target).replaceAll("\\", "/"));
    }
  }
  return found;
}

/**
 * Finds production source files with ripgrep or a dependency-free CI fallback.
 * @returns {string[]}
 */
function sourceFiles() {
  try {
    return execFileSync(
      "rg",
      ["--files", ...SOURCE_ROOTS, "-g", "*.ts", "-g", "*.js", "-g", "*.mjs"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return SOURCE_ROOTS.flatMap((directory) =>
      fallbackSourceFiles(join(REPOSITORY_ROOT, directory))
    ).sort();
  }
}

const files = sourceFiles();

const missing = [];
let namedFunctionCount = 0;
for (const file of files) {
  const text = readFileSync(join(REPOSITORY_ROOT, file), "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );

  /** Visits every syntax node and records undocumented named functions. */
  const visit = (node) => {
    const name = functionName(node, sourceFile);
    if (name !== null) {
      namedFunctionCount += 1;
      const anchor = documentationAnchor(node);
      if (!hasDocumentation(text, anchor, sourceFile)) {
        const line = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile)).line + 1;
        missing.push(`${file}:${line.toString()} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

if (missing.length > 0) {
  console.error(`Named functions require JSDoc:\n${missing.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `function-docs: ${namedFunctionCount.toString()} named functions documented across ${files.length.toString()} source files`,
  );
}
