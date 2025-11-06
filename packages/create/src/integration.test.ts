import { test, expect, afterAll, beforeAll, describe } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { create } from ".";

const execAsync = promisify(exec);

async function createTempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `${name}-${Date.now()}`);
  try {
    await fs.rm(dir, { recursive: true });
  } catch {
    // Ignore if directory doesn't exist
  }
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

type BuildTool = "tsdown" | "esbuild" | "vite" | "rollup" | "webpack" | "rspack";

function createFragmentTestSuite(buildTool: BuildTool, withDatabase: boolean) {
  return () => {
    let tempDir: string;
    const testConfig = {
      name: "@myorg/test",
      template: "fragment" as const,
      buildTool,
      agentDocs: "AGENTS.md" as const,
    };

    beforeAll(async () => {
      const suffix = withDatabase ? "db" : "no-db";
      tempDir = await createTempDir(`fragment-test-${buildTool}-${suffix}`);
      console.log("temp", tempDir);
      create({ ...testConfig, path: tempDir, withDatabase });
    });

    afterAll(async () => {
      await fs.rm(tempDir, { recursive: true });
    });

    describe.sequential(buildTool, () => {
      test("package.json correctly templated", async () => {
        const pkg = path.join(tempDir, "package.json");
        const pkgContent = await fs.readFile(pkg, "utf8");
        expect(pkgContent).toContain(testConfig.name);
      });

      test("agent file copied", async () => {
        const agentFile = path.join(tempDir, "AGENTS.md");
        await expect(fs.access(agentFile)).resolves.toBeUndefined();
      });

      test("installs", { timeout: 30000 }, async () => {
        const { stdout } = await execAsync("pnpm install", {
          cwd: tempDir,
          encoding: "utf8",
        });
        expect(stdout).toBeDefined();
      });

      test("compiles", { timeout: 30000 }, async () => {
        const { stdout } = await execAsync("pnpm run types:check", {
          cwd: tempDir,
          encoding: "utf8",
        });
        console.log(stdout);
        expect(stdout).toBeDefined();
      });
      /*
      FIXME: Skipping this test for rollup:
        When running rollup directly through pnpm run build or npm run build the build succeeds,
        but somehow when running through vitest the module resolution mechanism changes causing
        the build to fail.
      */
      test.skipIf(buildTool === "rollup")("builds", { timeout: 50000 }, async () => {
        const result = await execAsync("pnpm run build", {
          cwd: tempDir,
          encoding: "utf8",
        });

        expect(result).toBeDefined();
        await expect(fs.access(path.join(tempDir, "dist"))).resolves.toBeUndefined();
        await expect(fs.access(path.join(tempDir, "dist", "browser"))).resolves.toBeUndefined();

        const reactBundle = path.join(tempDir, "dist", "browser", "client", "react.js");
        const reactBundleContent = await fs.readFile(reactBundle, "utf8");
        // We expect the core package to be included in the fragment build,
        // each fragment has its own version of core so end-users don't have
        // to add it to their dependencies.
        expect(reactBundleContent).not.toMatch(/import\s+.*?\s+from\s+['"]@fragno-dev\/core/);
        // However, the peerDependencies of @fragno-dev/core must not be included
        expect(reactBundleContent).toMatch(/from\s*['"]react['"]/);

        // db should also not be included in the frontend
        expect(reactBundleContent).not.toMatch(/import\s+.*?\s+from\s+['"]@fragno-dev\/db/);

        // Vite builds only the browser bundle
        if (buildTool !== "vite") {
          await expect(fs.access(path.join(tempDir, "dist", "node"))).resolves.toBeUndefined();
        }
      });
    });
  };
}

describe.concurrent.each(["tsdown", "esbuild", "vite", "rollup", "webpack", "rspack"] as const)(
  "fragment with %s (with database)",
  (buildTool) => createFragmentTestSuite(buildTool, true)(),
);

describe("fragment with tsdown (without database)", createFragmentTestSuite("tsdown", false));
