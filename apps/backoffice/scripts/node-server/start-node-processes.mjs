import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** @typedef {{ name: "server" | "processor"; role: "web" | "processor"; entrypoint: string }} NodeBackofficeServiceDefinition */
/** @typedef {{ name: string; child: import("node:child_process").ChildProcess }} SupervisedService */
/** @typedef {{ kind: "error"; error: Error } | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }} SupervisedServiceCompletion */
/** @typedef {SupervisedServiceCompletion & { service: SupervisedService }} SupervisedServiceResult */
/** @typedef {{ kind: "signal"; signal: NodeJS.Signals } | { kind: "launcher-exited"; processId: number } | { kind: "service-exited"; result: SupervisedServiceResult }} SupervisorShutdownReason */
/** @typedef {{ url: string; apiKey: string }} LocalCodemodeBridgeEnvironment */

const backofficeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryDirectory = path.resolve(backofficeDirectory, "../..");
const localCodemodeBridgeDirectory = path.join(repositoryDirectory, "apps/cf-sandbox-bridge");
const localCodemodeBridgeUrl = "http://127.0.0.1:8787";
const gracefulShutdownTimeoutMs = 10_000;
/** @type {NodeBackofficeServiceDefinition[]} */
const serviceDefinitions = [
  { name: "server", role: "web", entrypoint: "build-node/node-server.mjs" },
  { name: "processor", role: "processor", entrypoint: "build-node/node-hook-processor.mjs" },
];

function localCodemodeBridgeIsEnabled() {
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
  const unknownArgument = arguments_.find((argument) => argument !== "--local-bridge");
  if (unknownArgument !== undefined) {
    throw new Error(`Node Backoffice supervisor received unknown argument: ${unknownArgument}`);
  }
  return arguments_.includes("--local-bridge");
}

/**
 * @param {string} contents
 * @param {LocalCodemodeBridgeEnvironment} environment
 */
function updateBackofficeBridgeDevVars(contents, environment) {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const pendingValues = new Map([
    ["CLOUDFLARE_BRIDGE_URL", environment.url],
    ["CLOUDFLARE_BRIDGE_API_KEY", environment.apiKey],
  ]);
  const bridgeVariableNames = new Set(pendingValues.keys());
  const updatedLines = [];
  for (const line of lines) {
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = assignment?.[1];
    if (name !== undefined && bridgeVariableNames.has(name)) {
      const value = pendingValues.get(name);
      if (value !== undefined) {
        updatedLines.push(`${name}=${JSON.stringify(value)}`);
        pendingValues.delete(name);
      }
      continue;
    }
    updatedLines.push(line);
  }

  if (pendingValues.size > 0 && updatedLines.length > 0 && updatedLines.at(-1) !== "") {
    updatedLines.push("");
  }
  for (const [name, value] of pendingValues) {
    updatedLines.push(`${name}=${JSON.stringify(value)}`);
  }
  return `${updatedLines.join(newline)}${newline}`;
}

/** @returns {LocalCodemodeBridgeEnvironment} */
function configureLocalCodemodeBridge() {
  const bridgeDevVarsPath = path.join(localCodemodeBridgeDirectory, ".dev.vars");
  let bridgeDevVars;
  try {
    bridgeDevVars = parseEnv(readFileSync(bridgeDevVarsPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Local codemode bridge requires apps/cf-sandbox-bridge/.dev.vars. Copy .dev.vars.example and set SANDBOX_API_KEY.",
      );
    }
    throw new Error("Local codemode bridge could not parse apps/cf-sandbox-bridge/.dev.vars.", {
      cause: error,
    });
  }

  const apiKey = bridgeDevVars.SANDBOX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Local codemode bridge requires SANDBOX_API_KEY in apps/cf-sandbox-bridge/.dev.vars.",
    );
  }

  const environment = { url: localCodemodeBridgeUrl, apiKey };
  const backofficeDevVarsPath = path.join(backofficeDirectory, ".dev.vars");
  let backofficeDevVarsExists = true;
  let backofficeDevVars;
  try {
    backofficeDevVars = readFileSync(backofficeDevVarsPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    backofficeDevVarsExists = false;
    backofficeDevVars = readFileSync(path.join(backofficeDirectory, ".dev.vars.example"), "utf8");
  }
  const updatedBackofficeDevVars = updateBackofficeBridgeDevVars(backofficeDevVars, environment);
  if (!backofficeDevVarsExists || updatedBackofficeDevVars !== backofficeDevVars) {
    writeFileSync(backofficeDevVarsPath, updatedBackofficeDevVars, { mode: 0o600 });
  }
  return environment;
}

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
 * @param {LocalCodemodeBridgeEnvironment | null} localBridgeEnvironment
 * @returns {SupervisedService}
 */
function spawnNodeBackofficeService(definition, localBridgeEnvironment) {
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
      env: {
        ...process.env,
        ...(localBridgeEnvironment === null
          ? {}
          : {
              CLOUDFLARE_BRIDGE_URL: localBridgeEnvironment.url,
              CLOUDFLARE_BRIDGE_API_KEY: localBridgeEnvironment.apiKey,
            }),
        BACKOFFICE_PROCESS_ROLE: definition.role,
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  return { name: definition.name, child };
}

/**
 * @param {LocalCodemodeBridgeEnvironment} environment
 * @returns {SupervisedService}
 */
function spawnLocalCodemodeBridge(environment) {
  const child = spawn("pnpm", ["run", "dev"], {
    cwd: localCodemodeBridgeDirectory,
    env: { ...process.env, SANDBOX_API_KEY: environment.apiKey },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return { name: "local codemode bridge", child };
}

/**
 * @param {SupervisedService} service
 * @returns {Promise<SupervisedServiceResult>}
 */
function observeSupervisedService(service) {
  return new Promise((resolve) => {
    let completed = false;
    /** @param {SupervisedServiceCompletion} result */
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
 * @param {SupervisedService[]} services
 * @param {NodeJS.Signals} signal
 */
function signalRunningServices(services, signal) {
  for (const { child } of services) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

const useLocalCodemodeBridge = localCodemodeBridgeIsEnabled();
const localBridgeEnvironment = useLocalCodemodeBridge ? configureLocalCodemodeBridge() : null;
const localBridgeService =
  localBridgeEnvironment === null ? null : spawnLocalCodemodeBridge(localBridgeEnvironment);
const nodeBackofficeServices = serviceDefinitions.map((definition) =>
  spawnNodeBackofficeService(definition, localBridgeEnvironment),
);
const services =
  localBridgeService === null
    ? nodeBackofficeServices
    : [localBridgeService, ...nodeBackofficeServices];
const launcherProcessIds = listLauncherProcessIds();
const observations = services.map(observeSupervisedService);
/** @type {{ shutdownReason: SupervisorShutdownReason | null; forcedShutdown: NodeJS.Timeout | null }} */
const supervisorState = { shutdownReason: null, forcedShutdown: null };

/** @param {SupervisorShutdownReason} reason */
function beginSupervisorShutdown(reason) {
  if (supervisorState.shutdownReason !== null) {
    return;
  }
  supervisorState.shutdownReason = reason;

  if (reason.kind === "signal") {
    console.info(
      `Node Backoffice supervisor received ${reason.signal}; waiting up to ${gracefulShutdownTimeoutMs / 1_000} seconds for server and processor shutdown`,
    );
  } else if (reason.kind === "launcher-exited") {
    console.warn(
      `Node Backoffice launcher process ${reason.processId} exited; requesting server and processor shutdown`,
    );
  } else {
    console.warn(
      `Node Backoffice ${reason.result.service.name} exited; requesting shutdown from the remaining service`,
    );
  }

  signalRunningServices(services, reason.kind === "signal" ? reason.signal : "SIGTERM");
  supervisorState.forcedShutdown = setTimeout(() => {
    const runningServiceNames = services
      .filter(({ child }) => child.exitCode === null && child.signalCode === null)
      .map(({ name }) => name);
    if (runningServiceNames.length > 0) {
      console.warn(
        `Node Backoffice graceful shutdown timed out after ${gracefulShutdownTimeoutMs / 1_000} seconds; sending SIGKILL to ${runningServiceNames.join(" and ")}`,
      );
      signalRunningServices(services, "SIGKILL");
    }
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
      return;
    }

    if (result.kind === "error") {
      console.error(`Node Backoffice ${result.service.name} failed during shutdown`, result.error);
      return;
    }

    console.info(
      `Node Backoffice ${result.service.name} process stopped (${result.signal ?? `exit ${result.code ?? 0}`})`,
    );
  });
}

console.info(
  `Node Backoffice supervisor started ${services.map((service) => `${service.name} ${service.child.pid}`).join(", ")}`,
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
} else {
  console.info("Node Backoffice supervisor shutdown complete");
}
