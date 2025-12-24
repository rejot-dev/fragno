#!/usr/bin/env node
/**
 * Randomly selects and displays a line of code from the repository.
 *
 * Usage: pnpm tsx scripts/roll-line.ts [options]
 *
 * Options:
 *   --file <path>    Only select from a specific file
 *   --ext <ext>      Only select from files with specific extension (e.g., .ts, .tsx)
 *   --context <n>    Show n lines of context around the selected line (default: 2)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

interface Options {
  file?: string;
  ext?: string;
  context: number;
}

const CODE_EXTENSIONS = [".ts", ".tsx", ".vue", ".svelte", ".astro"];
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".react-router",
  ".open-next",
  ".source",
  ".svelte-kit",
  ".output",
  "coverage",
  ".pglite",
  "_generated",
  "corpus-tests",
  ".beads",
  ".letta",
]);
const INCLUDE_DIRS = new Set(["example-apps", "example-fragments", "packages"]);
const PACKAGES_EXCLUDE = new Set(["create", "jsonforms-shadcn-renderers"]);
const IGNORE_FILES = new Set(["react.ts", "solid.ts", "svelte.ts", "vanilla.ts", "vue.ts"]);

function getAllCodeFiles(rootDir: string, options: Options): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number = 0): void {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            const dirName = entry;

            // At root level, only include specific directories
            if (depth === 0 && !INCLUDE_DIRS.has(dirName)) {
              continue;
            }

            // Inside packages directory, exclude specific subdirectories
            if (
              depth === 1 &&
              relative(rootDir, dir) === "packages" &&
              PACKAGES_EXCLUDE.has(dirName)
            ) {
              continue;
            }

            if (!IGNORE_DIRS.has(dirName) && !dirName.startsWith(".")) {
              walk(fullPath, depth + 1);
            }
          } else if (stat.isFile()) {
            // Skip test files
            if (entry.includes(".test.") || entry.includes(".spec.")) {
              continue;
            }

            // Skip framework adapter files
            if (IGNORE_FILES.has(entry)) {
              continue;
            }

            // If --file option is provided, only include that file
            if (options.file) {
              if (fullPath === options.file || fullPath.endsWith(options.file)) {
                files.push(fullPath);
              }
              continue;
            }

            // Filter by extension if specified
            if (options.ext) {
              if (extname(entry) === options.ext || extname(entry) === `.${options.ext}`) {
                files.push(fullPath);
              }
            } else {
              // Default: include all code files
              if (CODE_EXTENSIONS.includes(extname(entry))) {
                files.push(fullPath);
              }
            }
          }
        } catch {
          // Skip files/dirs we can't access
        }
      }
    } catch {
      // Skip directories we can't access
    }
  }

  walk(rootDir, 0);
  return files;
}

function getRandomLine(
  filePath: string,
  context: number,
): {
  line: string;
  lineNumber: number;
  contextLines: string[];
} | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    if (lines.length === 0) {
      return null;
    }

    // Filter out empty lines and boring lines for more interesting results
    const nonEmptyLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        const trimmed = line.trim();

        // Skip empty lines
        if (trimmed.length === 0) {
          return false;
        }

        // Skip lines that are just closing braces/brackets/parens
        if (/^[}\]);,]+$/.test(trimmed)) {
          return false;
        }

        // Skip lines that are just opening braces
        if (/^[{[(]+$/.test(trimmed)) {
          return false;
        }

        // Skip very short lines (less than 10 chars)
        if (trimmed.length < 10) {
          return false;
        }

        // Skip lines that are mostly punctuation
        const alphanumericCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
        if (alphanumericCount < trimmed.length * 0.3) {
          return false;
        }

        return true;
      });

    if (nonEmptyLines.length === 0) {
      return null;
    }

    // Randomly select a non-empty line
    const randomIndex = Math.floor(Math.random() * nonEmptyLines.length);
    const selected = nonEmptyLines[randomIndex];
    const lineNumber = selected.index + 1; // 1-based line numbers

    // Get context lines
    const start = Math.max(0, selected.index - context);
    const end = Math.min(lines.length, selected.index + context + 1);
    const contextLines = lines.slice(start, end);

    return {
      line: selected.line,
      lineNumber,
      contextLines,
    };
  } catch {
    return null;
  }
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = { context: 2 };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--file" && i + 1 < args.length) {
      options.file = args[++i];
    } else if (arg === "--ext" && i + 1 < args.length) {
      options.ext = args[++i];
    } else if (arg === "--context" && i + 1 < args.length) {
      options.context = parseInt(args[++i], 10) || 2;
    }
  }

  return options;
}

function main() {
  const options = parseArgs();
  const rootDir = process.cwd();

  // Get all code files
  const files = getAllCodeFiles(rootDir, options);

  if (files.length === 0) {
    console.error("No code files found matching the criteria.");
    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  }

  // Randomly select a file
  const randomFile = files[Math.floor(Math.random() * files.length)];

  // Get a random line from that file
  const result = getRandomLine(randomFile, options.context);

  if (!result) {
    console.error(`Could not read lines from ${randomFile}`);
    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  }

  // Display the result
  const relativePath = relative(rootDir, randomFile);
  console.log(`\n📄 File: ${relativePath}`);
  console.log(`📍 Line: ${result.lineNumber}`);
  console.log(`\n${"=".repeat(80)}\n`);

  // Show context with line numbers
  const startLine = Math.max(1, result.lineNumber - options.context);
  result.contextLines.forEach((line, index) => {
    const currentLineNumber = startLine + index;
    const marker = currentLineNumber === result.lineNumber ? "👉" : "  ";
    const lineNum = String(currentLineNumber).padStart(4);
    console.log(`${marker} ${lineNum} │ ${line}`);
  });

  console.log(`\n${"=".repeat(80)}\n`);
}

main();
