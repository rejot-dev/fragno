import { afterEach, assert, describe, test } from "vitest";

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseScriptPath = fileURLToPath(new URL("./run-worker-release.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

async function runWorkerReleaseOperation(operation: string, forwardedArguments: string[]) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "backoffice-worker-release-"));
  temporaryDirectories.push(temporaryDirectory);
  const invocationLogPath = path.join(temporaryDirectory, "wrangler-invocations.jsonl");
  const wranglerExecutablePath = path.join(temporaryDirectory, "wrangler");
  await writeFile(
    wranglerExecutablePath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.WRANGLER_INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
  );
  await chmod(wranglerExecutablePath, 0o755);

  return {
    invocationLogPath,
    result: spawnSync(process.execPath, [releaseScriptPath, operation, ...forwardedArguments], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PATH: `${temporaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        WRANGLER_INVOCATION_LOG: invocationLogPath,
      },
      encoding: "utf8",
    }),
  };
}

async function recordWorkerReleaseCommands(operation: string, forwardedArguments: string[]) {
  const { invocationLogPath, result } = await runWorkerReleaseOperation(
    operation,
    forwardedArguments,
  );
  assert(result.status === 0, result.stderr || result.stdout);

  return (await readFile(invocationLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Backoffice Worker release orchestration", () => {
  test("forwards bootstrap flags to both Worker deployments", async () => {
    const commands = await recordWorkerReleaseCommands("bootstrap", ["--", "--dry-run"]);

    assert.deepEqual(commands, [
      ["deploy", "--config", "build/server/wrangler.json", "--dry-run"],
      [
        "deploy",
        "--config",
        "dist/rejot_backoffice/wrangler.json",
        "--containers-rollout=none",
        "--dry-run",
      ],
    ]);
  });

  test("forwards upload tags to both Worker uploads", async () => {
    const commands = await recordWorkerReleaseCommands("upload", ["--", "--tag", "release-test"]);

    assert.deepEqual(commands, [
      ["versions", "upload", "--config", "build/server/wrangler.json", "--tag", "release-test"],
      [
        "versions",
        "upload",
        "--config",
        "dist/rejot_backoffice/wrangler.json",
        "--tag",
        "release-test",
      ],
    ]);
  });

  test("forwards a shared version tag to both Worker deployments", async () => {
    const commands = await recordWorkerReleaseCommands("deploy", [
      "--",
      "--version-tag",
      "release-test@100%",
      "--yes",
    ]);

    assert.deepEqual(commands, [
      [
        "versions",
        "deploy",
        "--config",
        "wrangler.web.jsonc",
        "--version-tag",
        "release-test@100%",
        "--yes",
      ],
      [
        "versions",
        "deploy",
        "--config",
        "wrangler.jsonc",
        "--version-tag",
        "release-test@100%",
        "--yes",
      ],
    ]);
  });

  test("rejects a positional Worker version ID", async () => {
    const { result } = await runWorkerReleaseOperation("deploy", [
      "--",
      "12345678-1234-1234-1234-123456789abc@100%",
      "--yes",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Backoffice release deploy does not accept Worker-specific version IDs/,
    );
  });

  test("rejects the Worker-specific version ID flag", async () => {
    const { result } = await runWorkerReleaseOperation("deploy", [
      "--",
      "--version-id",
      "12345678-1234-1234-1234-123456789abc",
      "--percentage",
      "100",
      "--yes",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Backoffice release deploy does not accept Worker-specific version IDs/,
    );
  });

  test("requires a shared version tag", async () => {
    const { result } = await runWorkerReleaseOperation("deploy", ["--", "--yes"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Backoffice release deploy requires --version-tag/);
  });
});
