import { spawn, execSync } from "node:child_process";
import path from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 5);
const leaseMs = Number(process.env.LEASE_MS ?? 60000);
const crashDelayMs = Number(process.env.CRASH_DELAY_MS ?? 2000);
const restartDelayMs = Number(process.env.RESTART_DELAY_MS ?? 3000);
const dbHost = process.env.PGHOST ?? "localhost";
const dbPort = Number(process.env.PGPORT ?? 5436);
const dbUser = process.env.PGUSER ?? "postgres";
const dbName = process.env.PGDATABASE ?? "wilco";
const dbPassword = process.env.PGPASSWORD ?? "postgres";

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method ?? "GET"} ${pathname} -> ${response.status}: ${text}`);
  }
  return response.status === 204 ? null : response.json();
}

async function createInstance(id) {
  return request(`/crash-test-workflow/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: {} }),
  });
}

function getAppPid() {
  if (process.env.APP_PID) {
    const pid = Number(process.env.APP_PID);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  }
  try {
    const output = execSync("lsof -n -iTCP:5173 -sTCP:LISTEN -t", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const pid = Number(output.split("\n")[0]);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  } catch {
    return null;
  }
  return null;
}

function killProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    console.warn(`Failed to kill pid ${pid}:`, error.message ?? error);
  }
}

function spawnDispatcher(label) {
  const dispatcherPath = path.resolve(
    "packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts",
  );
  const proc = spawn("tsx", [dispatcherPath], {
    env: { ...process.env, NODE_OPTIONS: "--conditions=development" },
    stdio: "ignore",
  });
  proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.warn(`[dispatcher ${label}] exited with code ${code}`);
    }
    if (signal) {
      console.warn(`[dispatcher ${label}] exited with signal ${signal}`);
    }
  });
  return proc;
}

function psqlQuery(query) {
  const cmd = [
    `PGPASSWORD=${dbPassword}`,
    "psql",
    `-h ${dbHost}`,
    `-p ${dbPort}`,
    `-U ${dbUser}`,
    `-d ${dbName}`,
    "-t",
    "-A",
    `-c "${query.replace(/"/g, '\\"')}"`,
  ].join(" ");
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `crash_${runId}_${i}`);

  console.log(`Creating ${ids.length} crash-test instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  await sleep(crashDelayMs);

  const appPid = getAppPid();
  if (!appPid) {
    throw new Error("Unable to determine app server PID on port 5173");
  }

  console.log(`Crashing app server pid=${appPid}...`);
  killProcess(appPid);

  await sleep(restartDelayMs);

  console.log("Starting recovery dispatcher...");
  const dispatcher = spawnDispatcher("recovery");

  const waitMs = leaseMs + 15000;
  console.log(`Waiting ${Math.round(waitMs / 1000)}s for lease expiry + recovery...`);
  await sleep(waitMs);

  const idList = ids.map((id) => `'${id}'`).join(",");
  const statusRows = psqlQuery(
    `select "instanceId", status from workflow_instance_workflows where "instanceId" in (${idList}) order by "instanceId";`,
  );
  const statuses = statusRows
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));

  const incomplete = statuses.filter(([, status]) => status !== "complete");
  if (incomplete.length) {
    console.error(`Instances not complete after crash recovery: ${incomplete.length}`);
    incomplete.slice(0, 5).forEach(([id, status]) => {
      console.error(`- ${id}: ${status}`);
    });
  }

  const staleProcessing = psqlQuery(
    "select count(*) from workflow_task_workflows where status='processing' and \"lockedUntil\" <= now();",
  );
  const stalePending = psqlQuery(
    "select count(*) from workflow_task_workflows where status='pending' and \"lockedUntil\" is not null;",
  );
  console.log(`Stale processing tasks: ${staleProcessing}`);
  console.log(`Pending tasks with lock: ${stalePending}`);

  const overAttempts = psqlQuery(
    'select count(*) from workflow_step_workflows where "maxAttempts" is not null and "attempts" > "maxAttempts";',
  );
  console.log(`Steps exceeding maxAttempts: ${overAttempts}`);

  dispatcher.kill("SIGTERM");

  if (incomplete.length || Number(staleProcessing) > 0 || Number(stalePending) > 0) {
    process.exit(1);
  }

  console.log("Crash recovery test finished with no detected anomalies.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
