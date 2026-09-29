import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ name: "server" | "processor"; role: "web" | "processor"; entrypoint: string }} NodeBackofficeServiceDefinition */
/** @typedef {NodeBackofficeServiceDefinition & { child: import("node:child_process").ChildProcess }} NodeBackofficeService */
/** @typedef {{ kind: "error"; error: Error } | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }} NodeBackofficeServiceCompletion */
/** @typedef {NodeBackofficeServiceCompletion & { service: NodeBackofficeService }} NodeBackofficeServiceResult */
/** @typedef {{ kind: "signal"; signal: NodeJS.Signals } | { kind: "launcher-exited"; processId: number } | { kind: "service-exited"; result: NodeBackofficeServiceResult }} SupervisorShutdownReason */

const backofficeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gracefulShutdownTimeoutMs = 10_000;
/** @type {NodeBackofficeServiceDefinition[]} */
const serviceDefinitions = [
  { name: "server", role: "web", entrypoint: "build-node/node-server.mjs" },
  { name: "processor", role: "processor", entrypoint: "build-node/node-hook-processor.mjs" },
];

/**
 * @param {number} processId
 * @returns {number | null}
 */
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

/** @returns {number[]} */
function listLauncherProcessIds() {
  /** @type {number[]} */
  const processIds = [];
  let processId = process.ppid;
  while (processId > 1 && !processIds.includes(processId)) {
    processIds.push(processId);
    processId = readParentProcessId(processId) ?? 1;
  }
  return processIds;
}

/**
 * @param {number} processId
 * @returns {boolean}
 */
function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * @param {NodeBackofficeServiceDefinition} definition
 * @returns {NodeBackofficeService}
 */
function spawnNodeBackofficeService(definition) {
  const child = spawn(
    process.execPath,
    [
      "--env-file-if-exists=.dev.vars",
      "--import",
      path.join(backofficeDirectory, "build-node/node-opentelemetry-bootstrap.mjs"),
      path.join(backofficeDirectory, definition.entrypoint),
    ],
    {
      cwd: backofficeDirectory,
      env: { ...process.env, BACKOFFICE_PROCESS_ROLE: definition.role },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  return { ...definition, child };
}

/**
 * @param {NodeBackofficeService} service
 * @returns {Promise<NodeBackofficeServiceResult>}
 */
function observeNodeBackofficeService(service) {
  return new Promise((resolve) => {
    let completed = false;
    /** @param {NodeBackofficeServiceCompletion} result */
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

/**
 * @param {NodeBackofficeService[]} services
 * @param {NodeJS.Signals} signal
 */
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
/** @type {{ shutdownReason: SupervisorShutdownReason | null; forcedShutdown: NodeJS.Timeout | null }} */
const supervisorState = { shutdownReason: null, forcedShutdown: null };

/** @param {SupervisorShutdownReason} reason */
function beginSupervisorShutdown(reason) {
  if (supervisorState.shutdownReason !== null) {
    return;
  }
  supervisorState.shutdownReason = reason;
  signalRunningServices(services, reason.kind === "signal" ? reason.signal : "SIGTERM");
  supervisorState.forcedShutdown = setTimeout(() => {
    signalRunningServices(services, "SIGKILL");
  }, gracefulShutdownTimeoutMs);
  supervisorState.forcedShutdown.unref();
}

/** @type {NodeJS.Signals[]} */
const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of shutdownSignals) {
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
    if (supervisorState.shutdownReason === null) {
      beginSupervisorShutdown({ kind: "service-exited", result });
    }
  });
}

console.info(
  `Node Backoffice supervisor started server ${services[0].child.pid} and processor ${services[1].child.pid}`,
);

const results = await Promise.all(observations);
clearInterval(launcherWatchdog);
if (supervisorState.forcedShutdown !== null) {
  clearTimeout(supervisorState.forcedShutdown);
}

if (supervisorState.shutdownReason?.kind === "service-exited") {
  const failedResult = supervisorState.shutdownReason.result;
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
