import { assert, describe, test } from "vitest";

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKOFFICE_WORKER_TOPOLOGY } from "../backoffice-worker-topology";

const backofficeDirectory = fileURLToPath(new URL("..", import.meta.url));
const deploymentScriptPath = resolve(backofficeDirectory, "scripts/deploy-backoffice-workers.ts");
const wranglerConfigPath = resolve(backofficeDirectory, "wrangler.jsonc");
const workerNames = [
  ...Object.values(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers).map((worker) => worker.name),
  BACKOFFICE_WORKER_TOPOLOGY.entryWorker.name,
];

type DeploymentScriptResult = {
  status: number | null;
  stderr: string;
  wranglerCommands: string[];
};

describe("Backoffice Worker version deployment", () => {
  test("bootstraps Workers that do not yet support version uploads", () => {
    const result = runDeploymentScript(["bootstrap", "--", "--tag", "bootstrap-123", "--dry-run"]);

    assert.equal(result.status, 0);
    assert.equal(result.wranglerCommands.length, workerNames.length);
    for (const [index] of workerNames.entries()) {
      assert.equal(
        result.wranglerCommands[index],
        workerBootstrapCommand(workerUploadConfigPath(index)),
      );
    }
  });

  test("uploads every Worker as an inactive version with one release tag", () => {
    const result = runDeploymentScript(["upload", "--", "--tag", "release-123", "--dry-run"]);

    assert.equal(result.status, 0);
    assert.equal(result.wranglerCommands.length, workerNames.length);
    for (const [index, command] of result.wranglerCommands.entries()) {
      assert.ok(command.includes("exec wrangler versions upload"));
      assert.ok(command.includes("--tag release-123"));
      assert.ok(command.includes("--dry-run"));
      assert.ok(command.includes(workerUploadConfigPath(index)));
    }
  });

  test("uploads one selected Worker", () => {
    const workerId = "internals";
    const workerIndex = Object.keys(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers).indexOf(
      workerId,
    );
    const result = runDeploymentScript([
      "upload",
      "--tag",
      "release-123",
      "--worker",
      workerId,
      "--dry-run",
    ]);

    assert.equal(result.status, 0);
    assert.deepEqual(result.wranglerCommands, [
      [
        "exec",
        "wrangler",
        "versions",
        "upload",
        "--config",
        workerUploadConfigPath(workerIndex),
        "--tag",
        "release-123",
        "--dry-run",
      ].join(" "),
    ]);
  });

  test("rejects an unknown Worker id before running Wrangler", () => {
    const result = runDeploymentScript([
      "upload",
      "--tag",
      "release-123",
      "--worker",
      "unknown-worker",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown Worker id 'unknown-worker'/);
    assert.deepEqual(result.wranglerCommands, []);
  });

  test("checks every version tag before activating any Worker", () => {
    const result = runDeploymentScript(["deploy", "--tag", "release-123"]);

    assert.equal(result.status, 0);
    assert.equal(result.wranglerCommands.length, workerNames.length * 2);

    const preflightCommands = result.wranglerCommands.slice(0, workerNames.length);
    const deploymentCommands = result.wranglerCommands.slice(workerNames.length);
    for (const [index, workerName] of workerNames.entries()) {
      assert.equal(
        preflightCommands[index],
        workerVersionDeployCommand(workerName, "release-123", true),
      );
      assert.equal(
        deploymentCommands[index],
        workerVersionDeployCommand(workerName, "release-123", false),
      );
    }
  });

  test("does not activate Workers when a version tag is missing during preflight", () => {
    const result = runDeploymentScript(
      ["deploy", "--tag", "release-123"],
      "--name rejot-backoffice-routes-api ",
    );

    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes(
        "Backoffice Worker version deployment preflight failed for 'rejot-backoffice-routes-api'",
      ),
    );
    assert.equal(result.wranglerCommands.length, 10);
    assert.ok(result.wranglerCommands.every((command) => command.endsWith("--dry-run")));
  });
});

function runDeploymentScript(
  args: readonly string[],
  failingCommandPattern = "",
): DeploymentScriptResult {
  const fakeExecutableDirectory = mkdtempSync(join(tmpdir(), "backoffice-worker-deploy-test-"));
  const commandLogPath = join(fakeExecutableDirectory, "wrangler-commands.log");
  const fakePnpmPath = join(fakeExecutableDirectory, "pnpm");

  writeFileSync(
    fakePnpmPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BACKOFFICE_DEPLOY_TEST_LOG"
if [ -n "$BACKOFFICE_DEPLOY_TEST_FAIL_PATTERN" ]; then
  case "$*" in
    *"$BACKOFFICE_DEPLOY_TEST_FAIL_PATTERN"*) exit 23 ;;
  esac
fi
`,
  );
  chmodSync(fakePnpmPath, 0o755);
  writeFileSync(commandLogPath, "");

  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", deploymentScriptPath, ...args],
      {
        cwd: backofficeDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeExecutableDirectory}:${process.env.PATH ?? ""}`,
          BACKOFFICE_DEPLOY_TEST_LOG: commandLogPath,
          BACKOFFICE_DEPLOY_TEST_FAIL_PATTERN: failingCommandPattern,
        },
      },
    );
    const commandLog = readFileSync(commandLogPath, "utf8").trim();

    return {
      status: result.status,
      stderr: result.stderr,
      wranglerCommands: commandLog ? commandLog.split("\n") : [],
    };
  } finally {
    rmSync(fakeExecutableDirectory, { recursive: true, force: true });
  }
}

function workerUploadConfigPath(index: number): string {
  if (index === workerNames.length - 1) {
    return resolve(backofficeDirectory, "dist/ssr/wrangler.json");
  }
  const workerId = Object.keys(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers)[index];
  return resolve(backofficeDirectory, `dist/routes_${workerId}/wrangler.json`);
}

function workerBootstrapCommand(configPath: string): string {
  return [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    configPath,
    "--tag",
    "bootstrap-123",
    "--dry-run",
  ].join(" ");
}

function workerVersionDeployCommand(
  workerName: string,
  versionTag: string,
  dryRun: boolean,
): string {
  return [
    "exec",
    "wrangler",
    "versions",
    "deploy",
    "--config",
    wranglerConfigPath,
    "--name",
    workerName,
    "--version-tag",
    `${versionTag}@100%`,
    "--yes",
    ...(dryRun ? ["--dry-run"] : []),
  ].join(" ");
}
