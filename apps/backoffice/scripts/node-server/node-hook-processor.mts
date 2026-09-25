import { createLocalBackofficeRuntime } from "../../app/backoffice-runtime/node/local-runtime";
import { startNodeBackofficeAlarmScheduler } from "../../app/backoffice-runtime/node/node-alarm-scheduler";
import { createNodeBackofficeDurableHooks } from "../../app/backoffice-runtime/node/node-durable-hooks";
import { createNodeBackofficeProcessConfig } from "./node-process-config";
import { stopNodeBackofficeOnSupervisorDisconnect } from "./node-supervisor-disconnect";

const config = await createNodeBackofficeProcessConfig();
const runtime = await createLocalBackofficeRuntime({
  sqliteDataDirectory: config.sqliteDataDirectory,
  runtimeEnv: config.runtimeEnv,
  durableHooks: createNodeBackofficeDurableHooks({ pollIntervalMs: 1_000 }),
});
const alarmScheduler = startNodeBackofficeAlarmScheduler(runtime);

console.info("Node Backoffice hook processor started");

let shutdownPromise: Promise<void> | null = null;

function shutdownNodeBackofficeHookProcessor(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    await alarmScheduler.stop();
    await runtime.cleanup();
  })();
  return shutdownPromise;
}

stopNodeBackofficeOnSupervisorDisconnect("hook processor", shutdownNodeBackofficeHookProcessor);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
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
