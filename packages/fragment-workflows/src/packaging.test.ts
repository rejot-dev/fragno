import { describe, expect, test } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execAsync = promisify(exec);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmPathPattern = /node_modules[\\/]\.pnpm[\\/]|\.pnpm-store[\\/]/;
const testPackagePattern = /@fragno-dev\/test/;

async function collectFiles(dir: string, extensions: Set<string>): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, extensions)));
      continue;
    }

    if (extensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

describe.sequential("packaging", () => {
  test.skip(
    "build output does not include pnpm store paths (slow: runs tsdown build)",
    { timeout: 120000 },
    async () => {
      await execAsync("pnpm exec tsdown --logLevel error", {
        cwd: packageRoot,
        maxBuffer: 10 * 1024 * 1024,
      });

      const distNodeDir = path.join(packageRoot, "dist", "node");
      const jsFiles = await collectFiles(distNodeDir, new Set([".js", ".mjs", ".cjs"]));
      const pnpmOffenders: string[] = [];
      const testImportOffenders: string[] = [];

      for (const file of jsFiles) {
        const contents = await fs.readFile(file, "utf8");
        const relativePath = path.relative(packageRoot, file);
        if (pnpmPathPattern.test(contents)) {
          pnpmOffenders.push(relativePath);
        }
        if (testPackagePattern.test(contents)) {
          testImportOffenders.push(relativePath);
        }
      }

      expect(pnpmOffenders).toEqual([]);
      expect(testImportOffenders).toEqual([]);
    },
  );
});
