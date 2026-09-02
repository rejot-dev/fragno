#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FormatOptions } from "oxfmt";

import { updateBackofficeContextGraphFile } from "../apps/backoffice-context-cli/src/context-graph-file.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const staticDirectory = resolve(repositoryRoot, "apps/backoffice/content/static");
const outputRepositoryPath = "content/CONTEXT-GRAPH.md";
const outputFile = resolve(repositoryRoot, outputRepositoryPath);
const formatterConfigFile = resolve(repositoryRoot, ".oxfmtrc.json");

function printUsage(): void {
  console.log(`Generate the checked-in Backoffice context graph.

Usage:
  pnpm backoffice:context
  pnpm backoffice:context:check
  pnpm backoffice:context:check-staged
`);
}

function readStagedContextGraph(): string | null {
  const stagedEntry = execFileSync("git", ["ls-files", "--stage", "--", outputRepositoryPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!stagedEntry.trim()) {
    return null;
  }
  return execFileSync("git", ["show", `:${outputRepositoryPath}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function generateBackofficeContextGraph(): Promise<void> {
  const args = process.argv.slice(2);
  const operation = args[0];
  if (
    args.length > 1 ||
    (operation !== undefined && operation !== "--check" && operation !== "--check-staged")
  ) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const formatterOptions = JSON.parse(await readFile(formatterConfigFile, "utf8")) as FormatOptions;
  const result = await updateBackofficeContextGraphFile({
    staticDirectory,
    outputFile,
    mode: operation === "--check" || operation === "--check-staged" ? "check" : "write",
    formatterOptions,
  });

  if (result.kind === "current" && operation === "--check-staged") {
    const workingContent = await readFile(outputFile, "utf8");
    const stagedContent = readStagedContextGraph();
    if (stagedContent !== workingContent) {
      console.error(
        `Staged Backoffice context graph is stale or missing: ${outputRepositoryPath}\nRun \`pnpm backoffice:context\`, then \`git add ${outputRepositoryPath}\`.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (result.kind === "stale") {
    console.error(
      `Backoffice context graph is stale: ${result.outputFile}\nRun \`pnpm backoffice:context\` and commit the result.`,
    );
    process.exitCode = 1;
  } else if (result.kind === "current") {
    console.log(`Backoffice context graph is up to date: ${result.outputFile}`);
  } else {
    console.log(`Generated Backoffice context graph: ${result.outputFile}`);
  }
}

generateBackofficeContextGraph().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Backoffice context graph generation failed: ${message}`);
  process.exitCode = 1;
});
