import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/api/workflows";
const dispatcherCount = Number(process.env.DISPATCHER_COUNT ?? 6);
const killDelayMs = Number(process.env.KILL_DELAY_MS ?? 2500);
const restartDelayMs = Number(process.env.RESTART_DELAY_MS ?? 2000);

if (!Number.isFinite(dispatcherCount) || dispatcherCount <= 0) {
  throw new Error(`Invalid DISPATCHER_COUNT: ${process.env.DISPATCHER_COUNT}`);
}

const dispatcherPath = path.resolve(
  "packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts",
);

const logsDir = process.env.LOGS_DIR ?? "/tmp";

const dispatchers = new Map();

function startDispatcher(index) {
  const logPath = path.join(logsDir, `wf-dispatcher-stress-${index}.log`);
  const out = fs.createWriteStream(logPath, { flags: "a" });
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const proc = spawn("tsx", [dispatcherPath], {
    env: { ...process.env, NODE_OPTIONS: "--conditions=development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  dispatchers.set(proc.pid, { proc, index, logPath, out, exitPromise, resolveExit });
  proc.on("exit", (code, signal) => {
    dispatchers.delete(proc.pid);
    out.end();
    resolveExit?.();
    if (code !== null && code !== 0) {
      console.warn(`[dispatcher ${index}] exited with code ${code}`);
    }
    if (signal) {
      console.warn(`[dispatcher ${index}] exited with signal ${signal}`);
    }
  });
  return proc;
}

function stopDispatcher(proc, signal = "SIGKILL") {
  if (!proc || proc.killed) {
    return;
  }
  try {
    proc.kill(signal);
  } catch (error) {
    console.warn(`Failed to kill dispatcher ${proc.pid}:`, error.message ?? error);
  }
}

async function runNodeScript(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [scriptPath], {
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptPath} exited with code ${code}`));
      }
    });
  });
}

function pickRandomDispatcher() {
  const values = Array.from(dispatchers.values());
  if (!values.length) {
    return null;
  }
  return values[Math.floor(Math.random() * values.length)];
}

async function main() {
  console.log(`Starting ${dispatcherCount} dispatchers...`);
  for (let i = 0; i < dispatcherCount; i += 1) {
    startDispatcher(i + 1);
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  console.log("Running parallel load with fault injection...");
  const killTimer = setTimeout(() => {
    const victim = pickRandomDispatcher();
    if (victim) {
      console.warn(`[fault] killing dispatcher ${victim.index} pid=${victim.proc.pid}`);
      stopDispatcher(victim.proc, "SIGKILL");
    }
  }, killDelayMs);

  const restartTimer = setTimeout(() => {
    const index = dispatcherCount + 1;
    console.warn(`[fault] restarting dispatcher ${index}`);
    startDispatcher(index);
  }, killDelayMs + restartDelayMs);

  try {
    await runNodeScript(
      path.resolve("packages/fragment-workflows/workflows-smoke-artifacts/load-parallel.js"),
      { BASE_URL: baseUrl },
    );
  } catch (error) {
    console.error("Parallel load failed:", error.message ?? error);
  } finally {
    clearTimeout(killTimer);
    clearTimeout(restartTimer);
  }

  console.log("Running approval concurrency load...");
  try {
    await runNodeScript(
      path.resolve("packages/fragment-workflows/workflows-smoke-artifacts/load-concurrency.js"),
      { BASE_URL: baseUrl },
    );
  } catch (error) {
    console.error("Approval concurrency load failed:", error.message ?? error);
  }

  console.log("Running wait-timeout edge test...");
  try {
    await runNodeScript(
      path.resolve("packages/fragment-workflows/workflows-smoke-artifacts/wait-timeout-edge.js"),
      { BASE_URL: baseUrl },
    );
  } catch (error) {
    console.error("Wait-timeout edge test failed:", error.message ?? error);
  }

  console.log("Stopping dispatchers...");
  const exitPromises = [];
  for (const entry of dispatchers.values()) {
    stopDispatcher(entry.proc, "SIGTERM");
    entry.out.end();
    exitPromises.push(entry.exitPromise);
  }

  const shutdownTimer = setTimeout(() => {
    for (const entry of dispatchers.values()) {
      stopDispatcher(entry.proc, "SIGKILL");
    }
  }, 1000);

  await Promise.race([
    Promise.all(exitPromises),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  clearTimeout(shutdownTimer);
  console.log("Stress/fault run completed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
