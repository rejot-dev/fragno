import { it, expect, afterAll, beforeAll, describe } from "vitest";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { create } from ".";

function createTempDir(name: string): string {
  const dir = path.join(tmpdir(), `${name}-${Date.now()}`);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe.each(["tsdown", "esbuild"] as const)("fragment with %s", (buildTool) => {
  let tempDir: string;
  const testConfig = { packageName: "@myorg/test" };

  beforeAll(() => {
    tempDir = createTempDir("fragment-test");
    create({ path: tempDir, template: "fragment", config: testConfig });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  it("package.json correctly templated", () => {
    const pkg = path.join(tempDir, "package.json");
    const pkgContent = fs.readFileSync(pkg, "utf8");
    expect(pkgContent).toContain(testConfig.packageName);
    expect(pkgContent).not.toContain("$TEMPLATED");
  });

  it("installs", async () => {
    const result = execSync("bun install", {
      cwd: tempDir,
      encoding: "utf8",
    });
    expect(result).toBeDefined();
  });

  it("compiles", async () => {
    const buildResult = execSync("bun run types:check", {
      cwd: tempDir,
      encoding: "utf8",
    });
    console.log(buildResult);
    expect(buildResult).toBeDefined();
  });
});
