import { createLocalBackofficeRuntime } from "../../app/backoffice-runtime/node/local-runtime";
import { createNodeBackofficeDurableHooks } from "../../app/backoffice-runtime/node/node-durable-hooks";
import { shutdownNodeOpenTelemetry } from "../../app/backoffice-runtime/node/node-opentelemetry-lifecycle";
import { createNodeBackofficeProcessConfig } from "./node-process-config";
import { stopNodeBackofficeOnSupervisorDisconnect } from "./node-supervisor-disconnect";

const config = await createNodeBackofficeProcessConfig();
const runtime = await createLocalBackofficeRuntime({
  sqliteDataDirectory: config.sqliteDataDirectory,
  runtimeEnv: config.runtimeEnv,
  workerTypeChecker: config.workerTypeChecker,
  createSandboxProviders: config.createSandboxProviders,
  durableHooks: createNodeBackofficeDurableHooks({ pollIntervalMs: 300 }),
});
console.info("Node Backoffice hook processor started");

let shutdownPromise: Promise<void> | null = null;

function shutdownNodeBackofficeHookProcessor(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    try {
      await runtime.cleanup();
    } finally {
      await shutdownNodeOpenTelemetry();
    }
    console.info("Node Backoffice hook processor shutdown complete");
  })();
  return shutdownPromise;
}

stopNodeBackofficeOnSupervisorDisconnect("hook processor", shutdownNodeBackofficeHookProcessor);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void shutdownNodeBackofficeHookProcessor().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Node Backoffice hook processor shutdown failed", error);
        process.exit(1);
      },
    );
  });
}
