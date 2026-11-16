import { describe, expect, it, assert } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolve(packageDirectory, "bin/run.js");

describe("Leyway CLI", () => {
  it("prints approachable help", () => {
    const output = execFileSync(process.execPath, [executable, "--help"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });

    expect(output).toContain("Usage:");
    expect(output).toContain("leyway login");
    expect(output).toContain("leyway scopes");
    expect(output).toContain("leyway listen org:acme");
    expect(output).toContain("org:<organization-slug>");
    expect(output).toContain("never the internal organization ID");
    expect(output).toContain("--after-versionstamp");
    expect(output).toContain("--force");
    expect(output).toContain("--start");
    expect(output).toContain("--wait");
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

  it.each(["--start", "--force", "--open"])("rejects --wait combined with %s", (flag) => {
    const result = spawnSync(process.execPath, [executable, "login", "--wait", flag], {
      cwd: packageDirectory,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    expect(result.stderr).toContain("Login options:");
  });

  it("prints the package version", () => {
    const output = execFileSync(process.execPath, [executable, "--version"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });

    assert(output.trim() === "0.1.0");
  });
});
