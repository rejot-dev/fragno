import { execSync } from "node:child_process";
import fs from "node:fs";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const count = Number(process.env.COUNT ?? 4);
const waitBeforeRestartMs = Number(process.env.WAIT_BEFORE_RESTART_MS ?? 2000);
const dbDownMs = Number(process.env.DB_DOWN_MS ?? 2500);
const waitAfterRestartMs = Number(process.env.WAIT_AFTER_RESTART_MS ?? 30000);
const pgPort = Number(process.env.PGPORT ?? 5436);
const pgUser = process.env.PGUSER ?? "postgres";
const pgDatabase = process.env.PGDATABASE ?? "wilco";
const pgPassword = process.env.PGPASSWORD ?? "postgres";
const pgCtl =
  process.env.PG_CTL ??
  (fs.existsSync("/Applications/Postgres.app/Contents/Versions/18/bin/pg_ctl")
    ? "/Applications/Postgres.app/Contents/Versions/18/bin/pg_ctl"
    : "pg_ctl");

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid COUNT: ${process.env.COUNT}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

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

function getPostgresPid() {
  try {
    const output = sh(`lsof -n -iTCP:${pgPort} -sTCP:LISTEN -t`);
    const pid = Number(output.split("\n")[0]);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  } catch {
    return null;
  }
  return null;
}

function getPostgresDataDir(pid) {
  if (process.env.PGDATA) {
    return process.env.PGDATA;
  }
  if (process.env.PGDATA_DIR) {
    return process.env.PGDATA_DIR;
  }
  if (!pid) {
    return null;
  }
  try {
    const args = sh(`ps -p ${pid} -o args=`);
    const marker = " -D ";
    const start = args.indexOf(marker);
    if (start !== -1) {
      const after = args.slice(start + marker.length);
      const nextFlags = [after.indexOf(" -p "), after.indexOf(" -c ")].filter((i) => i >= 0);
      const end = nextFlags.length ? Math.min(...nextFlags) : after.length;
      const dir = after.slice(0, end).trim();
      if (dir) {
        return dir;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function psqlQuery(query) {
  const cmd = [
    `PGPASSWORD=${pgPassword}`,
    "psql",
    `-h localhost`,
    `-p ${pgPort}`,
    `-U ${pgUser}`,
    `-d ${pgDatabase}`,
    "-t",
    "-A",
    `-c "${query.replace(/"/g, '\\"')}"`,
  ].join(" ");
  return sh(cmd);
}

async function waitForInstances(ids, timeoutMs = waitAfterRestartMs) {
  const started = Date.now();
  const idList = ids.map((id) => `'${id}'`).join(",");

  while (Date.now() - started < timeoutMs) {
    const rows = psqlQuery(
      `select "instanceId", status from workflow_instance_workflows where "instanceId" in (${idList}) order by "instanceId";`,
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

    const pending = rows.filter(
      ([, status]) => !["complete", "errored", "terminated"].includes(status),
    );
    if (pending.length === 0) {
      return rows;
    }
    await sleep(1500);
  }

  return null;
}

async function main() {
  const runId = Date.now().toString(36);
  const ids = Array.from({ length: count }, (_, i) => `db_restart_${runId}_${i}`);

  console.log(`Creating ${ids.length} crash-test instances...`);
  await Promise.all(ids.map((id) => createInstance(id)));

  console.log(`Waiting ${waitBeforeRestartMs}ms before DB restart...`);
  await sleep(waitBeforeRestartMs);

  const pid = getPostgresPid();
  if (!pid) {
    throw new Error("Unable to find Postgres PID for port " + pgPort);
  }
  const dataDir = getPostgresDataDir(pid);
  if (!dataDir) {
    throw new Error("Unable to determine Postgres data directory. Set PGDATA or PGDATA_DIR.");
  }

  console.log(`Restarting Postgres pid=${pid} dataDir=${dataDir}...`);
  sh(`${pgCtl} -D "${dataDir}" -m fast stop`);
  await sleep(dbDownMs);
  sh(`${pgCtl} -D "${dataDir}" -o "-p ${pgPort}" -w start`);

  console.log("Waiting for instances to settle...");
  const rows = await waitForInstances(ids, waitAfterRestartMs);

  const idList = ids.map((id) => `'${id}'`).join(",");
  const statusRows =
    rows ??
    psqlQuery(
      `select "instanceId", status from workflow_instance_workflows where "instanceId" in (${idList}) order by "instanceId";`,
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

  const incomplete = statusRows.filter(
    ([, status]) => !["complete", "errored", "terminated"].includes(status),
  );
  if (incomplete.length) {
    console.error(`Instances not in terminal state after DB restart: ${incomplete.length}`);
    incomplete.slice(0, 5).forEach(([id, status]) => console.error(`- ${id}: ${status}`));
  }

  const staleProcessing = psqlQuery(
    "select count(*) from workflow_task_workflows where status='processing' and \"lockedUntil\" <= now();",
  );
  const stalePending = psqlQuery(
    "select count(*) from workflow_task_workflows where status='pending' and \"lockedUntil\" is not null;",
  );
  console.log(`Stale processing tasks: ${staleProcessing}`);
  console.log(`Pending tasks with lock: ${stalePending}`);

  if (incomplete.length || Number(staleProcessing) > 0 || Number(stalePending) > 0) {
    process.exit(1);
  }

  console.log("DB restart mid-transaction test finished with no detected anomalies.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
