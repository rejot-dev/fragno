#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStaticContextOverviewMarkdown } from "./static-context-overview.js";

const defaultStaticDirectory = fileURLToPath(
  new URL("../../backoffice/content/static/", import.meta.url),
);

function printUsage(): void {
  console.log(`Backoffice context CLI

Print a Markdown agent-context call graph rooted at SYSTEM.md and every SKILL.md.

Usage:
  backoffice-context [static-directory]

Arguments:
  static-directory  Backoffice static content directory
                    Default: apps/backoffice/content/static

Options:
  -h, --help        Show this help

Examples:
  backoffice-context
  backoffice-context > backoffice-context.md
  backoffice-context ./apps/backoffice/content/static
`);
}

/** Runs the Backoffice static context debugger. */
export async function runBackofficeContextCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  if (argv.length > 1 || argv[0]?.startsWith("-")) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const staticDirectory = argv[0] ? resolve(argv[0]) : defaultStaticDirectory;
  try {
    process.stdout.write(await createStaticContextOverviewMarkdown(staticDirectory));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Backoffice context CLI error: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runBackofficeContextCli();
}
