import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const approvalCount = Number(process.env.APPROVAL_COUNT ?? 10);
const crashCount = Number(process.env.CRASH_COUNT ?? 4);
const crashDelayMs = Number(process.env.CRASH_DELAY_MS ?? 3000);
const recoveryWaitMs = Number(process.env.RECOVERY_WAIT_MS ?? 90000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 1000);

if (!Number.isFinite(approvalCount) || approvalCount < 0) {
  throw new Error(`Invalid APPROVAL_COUNT: ${process.env.APPROVAL_COUNT}`);
}
if (!Number.isFinite(crashCount) || crashCount < 0) {
  throw new Error(`Invalid CRASH_COUNT: ${process.env.CRASH_COUNT}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

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

async function createInstance(workflow, id, params) {
  return request(`/${workflow}/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params }),
  });
}

async function sendEvent(workflow, id, type, payload) {
  return request(`/${workflow}/instances/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function getStatus(workflow, id) {
  return request(`/${workflow}/instances/${id}`);
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
      WF_STUCK_PROCESSING_TIMEOUT_MINUTES:
        process.env.WF_STUCK_PROCESSING_TIMEOUT_MINUTES ?? "0.05",
    },
    stdio: "ignore",
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

async function stopDispatcher(proc, signal = "SIGTERM") {
  if (!proc || proc.killed) {
    return;
  }
  proc.kill(signal);
  await Promise.race([proc.exitPromise, sleep(3000)]);
}

async function main() {
  const runId = Date.now().toString(36);
  const approvalIds = Array.from({ length: approvalCount }, (_, i) => `dc_app_${runId}_${i}`);
  const crashIds = Array.from({ length: crashCount }, (_, i) => `dc_crash_${runId}_${i}`);

  console.log("Starting dispatcher...");
  let dispatcher = spawnDispatcher("primary");

  console.log(`Creating ${approvalIds.length} approval instances...`);
  await Promise.all(
    approvalIds.map((id) =>
      createInstance("approval-workflow", id, {
        requestId: `req_${id}`,
        amount: 100,
        requestedBy: "crash",
      }),
    ),
  );

  console.log(`Creating ${crashIds.length} crash-test instances...`);
  await Promise.all(crashIds.map((id) => createInstance("crash-test-workflow", id, {})));

  await sleep(crashDelayMs);

  console.log(`Crashing dispatcher pid=${dispatcher.pid}...`);
  dispatcher.kill("SIGKILL");

  console.log("Sending approval + fulfillment events while dispatcher is down...");
  await Promise.all(
    approvalIds.map((id) =>
      sendEvent("approval-workflow", id, "approval", { approved: true, approver: "crash" }),
    ),
  );
  await Promise.all(
    approvalIds.map((id) =>
      sendEvent("approval-workflow", id, "fulfillment", { confirmationId: `conf_${id}` }),
    ),
  );

  await sleep(2000);

  console.log("Restarting dispatcher...");
  dispatcher = spawnDispatcher("recovery");

  console.log(`Waiting up to ${Math.round(recoveryWaitMs / 1000)}s for recovery...`);
  const deadline = Date.now() + recoveryWaitMs;
  const pendingApproval = new Set(approvalIds);
  const pendingCrash = new Set(crashIds);

  while ((pendingApproval.size || pendingCrash.size) && Date.now() < deadline) {
    await Promise.all(
      Array.from(pendingApproval).map(async (id) => {
        const status = await getStatus("approval-workflow", id);
        if (["complete", "errored", "terminated"].includes(status.details.status)) {
          pendingApproval.delete(id);
        }
      }),
    );
    await Promise.all(
      Array.from(pendingCrash).map(async (id) => {
        const status = await getStatus("crash-test-workflow", id);
        if (["complete", "errored", "terminated"].includes(status.details.status)) {
          pendingCrash.delete(id);
        }
      }),
    );
    if (pendingApproval.size || pendingCrash.size) {
      await sleep(pollIntervalMs);
    }
  }

  if (pendingApproval.size) {
    console.error(`Approval instances stuck after dispatcher crash: ${pendingApproval.size}`);
    pendingApproval.forEach((id) => console.error(`- ${id}`));
  }

  if (pendingCrash.size) {
    console.error(`Crash-test instances stuck after dispatcher crash: ${pendingCrash.size}`);
    pendingCrash.forEach((id) => console.error(`- ${id}`));
  }

  await stopDispatcher(dispatcher);

  if (pendingApproval.size || pendingCrash.size) {
    process.exit(1);
  }

  console.log("Dispatcher crash recovery test finished with no detected anomalies.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
