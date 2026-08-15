/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
// Enforces documentation for named production functions without demanding
// comments on short anonymous callbacks such as map and event handlers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

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

const files = execFileSync(
  "rg",
  [
    "--files",
    "src",
    "web/src",
    "extension/shared",
    "scripts",
    "-g",
    "*.ts",
    "-g",
    "*.js",
    "-g",
    "*.mjs",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const missing = [];
let namedFunctionCount = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
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
