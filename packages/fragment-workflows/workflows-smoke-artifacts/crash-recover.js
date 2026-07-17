import { execFileSync, execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { assert, assertEqual, baseUrl, createInstance, runId, sleep } from "./smoke-support.js";

const count = Number(process.env.COUNT ?? 5);
const crashDelayMs = Number(process.env.CRASH_DELAY_MS ?? 2_000);
const recoveryTimeoutMs = Number(process.env.RECOVERY_TIMEOUT_MS ?? 45_000);
const appPort = Number(new URL(baseUrl).port || 80);
const databaseUrl =
  process.env.WF_EXAMPLE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  `postgres://${process.env.PGUSER ?? "postgres"}:${process.env.PGPASSWORD ?? "postgres"}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? 5436}/${process.env.PGDATABASE ?? "wilco"}`;
const require = createRequire(import.meta.url);

function getAppPid() {
  if (process.env.APP_PID) {
    const pid = Number(process.env.APP_PID);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  }
  try {
    const output = execSync(`lsof -n -iTCP:${appPort} -sTCP:LISTEN -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const pid = Number(output.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function psqlQuery(query) {
  return execFileSync("psql", [databaseUrl, "-t", "-A", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function buildTsxCommand(dispatcherPath) {
  if (process.env.TSX_BIN) {
    return { command: process.env.TSX_BIN, args: [dispatcherPath] };
  }
  require.resolve("tsx");
  return {
    command: process.execPath,
    args: ["--conditions=development", "--import", "tsx", dispatcherPath],
  };
}

function spawnDispatcher(label) {
  const dispatcherPath = path.resolve(
    "packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts",
  );
  const tsx = buildTsxCommand(dispatcherPath);
  const proc = spawn(tsx.command, tsx.args, {
    env: {
      ...process.env,
      WF_EXAMPLE_DATABASE_URL: databaseUrl,
      WF_STUCK_PROCESSING_TIMEOUT_MINUTES:
        process.env.WF_STUCK_PROCESSING_TIMEOUT_MINUTES ?? "0.05",
    },
    stdio: "inherit",
  });
  proc.exitPromise = new Promise((resolve) => {
    proc.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.warn(`[dispatcher ${label}] exited with code ${code}`);
      }
      if (signal) {
        console.warn(`[dispatcher ${label}] exited with signal ${signal}`);
      }
      resolve();
    });
  });
  return proc;
}

async function stopDispatcher(proc) {
  if (!proc || proc.killed) {
    return;
  }
  proc.kill("SIGTERM");
  await Promise.race([proc.exitPromise, sleep(3000)]);
}

async function main() {
  assert(Number.isFinite(count) && count > 0, `Invalid COUNT: ${count}`);
  const prefix = runId("crash");
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_${index}`);

  console.log(`[crash-recover] baseUrl=${baseUrl} creating ${ids.length} crash-test instances`);
  await Promise.all(ids.map((id) => createInstance("crash-test-workflow", id, {})));
  await sleep(crashDelayMs);

  const appPid = getAppPid();
  assert(appPid, `Unable to determine app server PID on port ${appPort}; set APP_PID explicitly`);
  console.log(`[crash-recover] killing app server pid=${appPid}`);
  process.kill(appPid, "SIGKILL");

  console.log("[crash-recover] starting external recovery dispatcher");
  const dispatcher = spawnDispatcher("recovery");
  try {
    const deadline = Date.now() + recoveryTimeoutMs;
    let rows = [];
    while (Date.now() < deadline) {
      const idList = ids.map((id) => `'${id}'`).join(",");
      const raw = psqlQuery(
        `select id, status from workflows.workflow_instance where id in (${idList}) order by id;`,
      );
      rows = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("|"));
      if (rows.length === ids.length && rows.every(([, status]) => status === "complete")) {
        break;
      }
      await sleep(1_000);
    }

    const incomplete = rows.filter(([, status]) => status !== "complete");
    assertEqual("incomplete instances", incomplete.length, 0);

    const overAttempts = Number(
      psqlQuery('select count(*) from workflows.workflow_step where "attempts" > "maxAttempts";'),
    );
    assertEqual("steps exceeding maxAttempts", overAttempts, 0);
  } finally {
    await stopDispatcher(dispatcher);
  }

  console.log("[crash-recover] complete");
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
