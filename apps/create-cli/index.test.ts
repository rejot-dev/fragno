import { test, expect, afterEach } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const execAsync = promisify(exec);

const CLI_PATH = path.resolve(import.meta.dirname, "index.ts");
const TSX_PATH = path.resolve(import.meta.dirname, "../../node_modules/.bin/tsx");

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), "create-cli-test-"));
}

async function runCli(args: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`${TSX_PATH} ${CLI_PATH} ${args}`, { cwd, encoding: "utf8" });
}

afterEach<{ tempDir?: string }>(async (ctx) => {
  if (ctx.tempDir) {
    await fs.rm(ctx.tempDir, { recursive: true });
  }
});

test("non-interactive mode creates project with defaults", async (ctx) => {
  const tempDir = await createTempDir();
  Object.assign(ctx, { tempDir });

  const projectPath = path.join(tempDir, "my-test-fragment");
  const { stdout } = await runCli(
    `--non-interactive --name my-test-fragment --path ${projectPath}`,
    tempDir,
  );

  expect(stdout).toContain("Project created successfully!");

  // Verify package.json was created with correct name
  const pkg = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf8"));
  expect(pkg.name).toBe("my-test-fragment");

  // Verify database files are included (default: withDatabase=true)
  await expect(fs.access(path.join(projectPath, "src", "schema.ts"))).resolves.toBeUndefined();

  // Verify agent docs are NOT included (default: agentDocs=none)
  await expect(fs.access(path.join(projectPath, "AGENTS.md"))).rejects.toThrow();
  await expect(fs.access(path.join(projectPath, "CLAUDE.md"))).rejects.toThrow();
});
