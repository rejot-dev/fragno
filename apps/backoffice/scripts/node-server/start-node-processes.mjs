import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backofficeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gracefulShutdownTimeoutMs = 10_000;
const serviceDefinitions = [
  { name: "server", entrypoint: "build-node/node-server.mjs" },
  { name: "processor", entrypoint: "build-node/node-hook-processor.mjs" },
];

function readParentProcessId(processId) {
  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-p", String(processId)], {
      encoding: "utf8",
    }).trim();
    const parentProcessId = Number(output);
    return Number.isInteger(parentProcessId) && parentProcessId > 0 ? parentProcessId : null;
  } catch {
    return null;
  }
}

function listLauncherProcessIds() {
  const processIds = [];
  let processId = process.ppid;
  while (processId > 1 && !processIds.includes(processId)) {
    processIds.push(processId);
    processId = readParentProcessId(processId) ?? 1;
  }
  return processIds;
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function spawnNodeBackofficeService(definition) {
  const child = spawn(
    process.execPath,
    ["--env-file=.dev.vars", path.join(backofficeDirectory, definition.entrypoint)],
    {
      cwd: backofficeDirectory,
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  return { ...definition, child };
}

function observeNodeBackofficeService(service) {
  return new Promise((resolve) => {
    let completed = false;
    function complete(result) {
      if (completed) {
        return;
      }
      completed = true;
      resolve({ service, ...result });
    }

    service.child.once("error", (error) => {
      complete({ kind: "error", error });
    });
    service.child.once("exit", (code, signal) => {
      complete({ kind: "exit", code, signal });
    });
  });
}

function signalRunningServices(services, signal) {
  for (const { child } of services) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

const launcherProcessIds = listLauncherProcessIds();
const services = serviceDefinitions.map(spawnNodeBackofficeService);
const observations = services.map(observeNodeBackofficeService);
let shutdownReason = null;
let forcedShutdown = null;

function beginSupervisorShutdown(reason) {
  if (shutdownReason !== null) {
    return;
  }
  shutdownReason = reason;
  signalRunningServices(services, reason.kind === "signal" ? reason.signal : "SIGTERM");
  forcedShutdown = setTimeout(() => {
    signalRunningServices(services, "SIGKILL");
  }, gracefulShutdownTimeoutMs);
  forcedShutdown.unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    beginSupervisorShutdown({ kind: "signal", signal });
  });
}

const launcherWatchdog = setInterval(() => {
  const exitedLauncherProcessId = launcherProcessIds.find(
    (processId) => !processIsAlive(processId),
  );
  if (exitedLauncherProcessId !== undefined) {
    beginSupervisorShutdown({ kind: "launcher-exited", processId: exitedLauncherProcessId });
  }
}, 1_000);
launcherWatchdog.unref();

for (const observation of observations) {
  void observation.then((result) => {
    if (shutdownReason === null) {
      beginSupervisorShutdown({ kind: "service-exited", result });
    }
  });
}

console.info(
  `Node Backoffice supervisor started server ${services[0].child.pid} and processor ${services[1].child.pid}`,
);

const results = await Promise.all(observations);
clearInterval(launcherWatchdog);
if (forcedShutdown !== null) {
  clearTimeout(forcedShutdown);
}

if (shutdownReason?.kind === "service-exited") {
  const failedResult = shutdownReason.result;
  if (failedResult.kind === "error") {
    console.error(
      `Node Backoffice ${failedResult.service.name} failed to start`,
      failedResult.error,
    );
    process.exitCode = 1;
  } else {
    console.error(
      `Node Backoffice ${failedResult.service.name} exited unexpectedly`,
      failedResult.signal ?? failedResult.code,
    );
    process.exitCode = failedResult.code && failedResult.code > 0 ? failedResult.code : 1;
  }
} else if (results.some((result) => result.kind === "error")) {
  process.exitCode = 1;
}
