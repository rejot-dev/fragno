import { describe, expect, test } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeToolFamiliesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "families");

const runtimeToolFamilyFiles = readdirSync(runtimeToolFamiliesDir)
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => !file.endsWith(".test.ts"))
  .filter((file) => !file.endsWith("-runtime.ts"))
  .map((file) => path.join(runtimeToolFamiliesDir, file));

const expressionBodiedAsyncExecutePattern = /execute:\s*async\s*\([^)]*\)\s*=>\s*(\S+)/g;

const lineNumberAt = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

describe("runtime tool async execute definitions", () => {
  test("await expression-bodied async execute implementations", () => {
    const violations = runtimeToolFamilyFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(expressionBodiedAsyncExecutePattern)]
        .filter((match) => match[1] !== "await" && match[1] !== "{")
        .map((match) => ({
          file: path.relative(process.cwd(), file),
          line: lineNumberAt(source, match.index ?? 0),
          firstToken: match[1],
        }));
    });

    expect(violations).toEqual([]);
  });
});
