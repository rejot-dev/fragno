import { describe, expect, it, assert } from "vitest";

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolve(packageDirectory, "bin/run.js");

describe("backoffice CLI", () => {
  it("prints approachable help", () => {
    const output = execFileSync(process.execPath, [executable, "--help"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });

    expect(output).toContain("Usage:");
    expect(output).toContain("backoffice login");
    expect(output).toContain("--force");
    expect(output).toContain("Scopes:");
  });

  it("prints the package version", () => {
    const output = execFileSync(process.execPath, [executable, "--version"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });

    assert(output.trim() === "0.1.0");
  });
});
