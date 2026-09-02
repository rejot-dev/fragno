import { describe, expect, it, assert } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
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
    expect(output).toContain("backoffice scopes");
    expect(output).toContain("org:<organization-slug>");
    expect(output).toContain("never the internal organization ID");
    expect(output).toContain("--force");
    expect(output).toContain("Scope syntax:");
  });

  it("rejects absolute upload destinations outside /workspace", () => {
    const result = spawnSync(
      process.execPath,
      [executable, "upload", "org:org-1", "source.txt", "/static/report.txt"],
      {
        cwd: packageDirectory,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    expect(result.stderr).toContain("Workspace path must identify a file inside /workspace.");
  });

  it("prints the package version", () => {
    const output = execFileSync(process.execPath, [executable, "--version"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });

    assert(output.trim() === "0.1.0");
  });
});
