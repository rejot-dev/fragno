import { assert, test } from "vitest";

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKOFFICE_WORKER_TOPOLOGY } from "../backoffice-worker-topology";

const backofficeDirectory = fileURLToPath(new URL("..", import.meta.url));
const statusScriptPath = resolve(backofficeDirectory, "scripts/show-backoffice-worker-status.ts");
const workerNames = [
  ...Object.values(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers).map((worker) => worker.name),
  BACKOFFICE_WORKER_TOPOLOGY.entryWorker.name,
];

test("shows recent uploads and the deployed version for every Backoffice Worker", () => {
  const result = runStatusScript();

  assert.equal(result.status, 0);
  assert.equal(result.wranglerCommands.length, workerNames.length * 2);
  for (const [workerIndex, workerName] of workerNames.entries()) {
    assert.match(result.stdout, new RegExp(`${workerName}\\n`));
    const workerCommands = result.wranglerCommands.slice(workerIndex * 2, workerIndex * 2 + 2);
    assert.equal(workerCommands.length, 2);
    assert.ok(workerCommands.every((command) => command.includes(`--name ${workerName} --json`)));
  }
  assert.match(result.stdout, /Deployed: 2026-08-26T12:10:20.175972Z/);
  assert.match(result.stdout, /#2 release-123 version-deployed @ 100%/);
  assert.match(
    result.stdout,
    /#3 release-456 version-uploaded 2026-08-26T13:00:00.000000Z \[uploaded\]/,
  );
});

test("reports an unavailable Worker without hiding the remaining Workers", () => {
  const unavailableWorker = BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers.api.name;
  const result = runStatusScript(unavailableWorker);

  assert.equal(result.status, 1);
  assert.equal(result.wranglerCommands.length, workerNames.length * 2);
  assert.match(result.stdout, new RegExp(`${unavailableWorker}\\n  Uploads: unavailable`));
  assert.match(result.stdout, new RegExp(`${BACKOFFICE_WORKER_TOPOLOGY.entryWorker.name}\\n`));
});

function runStatusScript(failingWorkerName = "") {
  const fakeExecutableDirectory = mkdtempSync(join(tmpdir(), "backoffice-worker-status-test-"));
  const commandLogPath = join(fakeExecutableDirectory, "wrangler-commands.log");
  const fakePnpmPath = join(fakeExecutableDirectory, "pnpm");

  writeFileSync(
    fakePnpmPath,
    `#!/bin/sh
printf '%s\n' "$*" >> "$BACKOFFICE_STATUS_TEST_LOG"
case "$*" in
  *"$BACKOFFICE_STATUS_TEST_FAIL_WORKER"*)
    if [ -n "$BACKOFFICE_STATUS_TEST_FAIL_WORKER" ]; then
      printf 'Worker does not exist\n' >&2
      exit 1
    fi
    ;;
esac
case "$*" in
  *"versions list"*)
    printf '%s\n' '[{"id":"version-deployed","number":2,"metadata":{"created_on":"2026-08-26T12:00:00.000000Z"},"annotations":{"workers/tag":"release-123"}},{"id":"version-uploaded","number":3,"metadata":{"created_on":"2026-08-26T13:00:00.000000Z"},"annotations":{"workers/tag":"release-456"}}]'
    ;;
  *"deployments status"*)
    printf '%s\n' '{"created_on":"2026-08-26T12:10:20.175972Z","versions":[{"version_id":"version-deployed","percentage":100}]}'
    ;;
esac
`,
  );
  chmodSync(fakePnpmPath, 0o755);

  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", statusScriptPath], {
      cwd: backofficeDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeExecutableDirectory}:${process.env.PATH ?? ""}`,
        BACKOFFICE_STATUS_TEST_LOG: commandLogPath,
        BACKOFFICE_STATUS_TEST_FAIL_WORKER: failingWorkerName,
      },
    });
    const commandLog = readFileSync(commandLogPath, "utf8").trim();

    return {
      status: result.status,
      stdout: result.stdout,
      wranglerCommands: commandLog ? commandLog.split("\n") : [],
    };
  } finally {
    rmSync(fakeExecutableDirectory, { recursive: true, force: true });
  }
}
