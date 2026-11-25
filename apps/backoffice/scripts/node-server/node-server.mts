import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import type { ServerBuild } from "react-router";

import { allLocalObjects } from "../../app/backoffice-runtime/all-local-objects";
import { createLocalBackofficeRuntime } from "../../app/backoffice-runtime/node/local-runtime";
import { startNodeBackofficeAlarmScheduler } from "../../app/backoffice-runtime/node/node-alarm-scheduler";
import { createExternallyProcessedNodeBackofficeDurableHooks } from "../../app/backoffice-runtime/node/node-durable-hooks";
import { shutdownNodeOpenTelemetry } from "../../app/backoffice-runtime/node/node-opentelemetry-lifecycle";
import { mountBackofficeHandler } from "./node-backoffice-handler";
import { createNodeBackofficeProcessConfig } from "./node-process-config";
import { registerNodeBackofficeRequestObservability } from "./node-request-observability";
import { registerNodeBackofficeHealthCheck } from "./node-server-health";
import {
  formatNodeBackofficeListenUrls,
  startNodeBackofficeListeners,
  stopNodeBackofficeListeners,
} from "./node-server-listeners";
import { configureNodeBackofficeProxy } from "./node-server-proxy";
import { stopNodeBackofficeOnSupervisorDisconnect } from "./node-supervisor-disconnect";

const serverBuild = (await import(
  new URL("./server/index.js", import.meta.url).href
)) as ServerBuild;

const config = await createNodeBackofficeProcessConfig();
const runtime = await createLocalBackofficeRuntime({
  objects: allLocalObjects,
  sqliteDataDirectory: config.sqliteDataDirectory,
  runtimeEnv: config.runtimeEnv,
  workerTypeChecker: config.workerTypeChecker,
  createSandboxProviders: config.createSandboxProviders,
  durableHooks: createExternallyProcessedNodeBackofficeDurableHooks(),
});
// Durable Object alarms must run beside HTTP/RPC object instances. A second process opening the
// same Pi harness would classify active tasks as crash recovery and repeat in-flight model calls.
const alarmScheduler = startNodeBackofficeAlarmScheduler(runtime);
const staticDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "client");
const app = express();
app.disable("x-powered-by");
registerNodeBackofficeRequestObservability(app);
registerNodeBackofficeHealthCheck(app);
configureNodeBackofficeProxy(
  app,
  config.publicBaseUrl,
  process.env.BACKOFFICE_TRUST_PROXY ?? "loopback",
);
app.use(
  "/assets",
  express.static(path.join(staticDirectory, "assets"), {
    maxAge: "1y",
    immutable: true,
    index: false,
    redirect: false,
  }),
);
app.use(express.static(staticDirectory, { maxAge: "1m", index: false, redirect: false }));
mountBackofficeHandler(app, { runtime, build: serverBuild, mode: "production" });

const listeners = await startNodeBackofficeListeners({
  requestListener(request, response) {
    app(request, response);
  },
  hosts: config.listenHosts,
  port: config.port,
}).catch(async (error: unknown) => {
  try {
    await alarmScheduler.stop();
    await runtime.cleanup();
  } catch (cleanupError) {
    console.error("Node Backoffice startup cleanup failed", cleanupError);
  } finally {
    await shutdownNodeOpenTelemetry();
  }
  throw error;
});
console.info(
  `Node Backoffice listening on ${formatNodeBackofficeListenUrls(listeners, config.port)}`,
);

let shutdownPromise: Promise<void> | null = null;

function shutdownNodeBackofficeServer(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    try {
      console.info("Node Backoffice server shutdown started: closing HTTP listeners");
      const activeResponseCount = listeners.reduce(
        (count, listener) => count + listener.activeResponses.size,
        0,
      );
      console.info(`Node Backoffice server closing ${activeResponseCount} active response(s)`);
      await stopNodeBackofficeListeners(listeners);
      console.info("Node Backoffice server HTTP listeners closed: stopping alarm scheduler");
      await alarmScheduler.stop();
      console.info("Node Backoffice server alarm scheduler stopped: cleaning up runtime");
      await runtime.cleanup();
    } finally {
      await shutdownNodeOpenTelemetry();
    }
    console.info("Node Backoffice server shutdown complete");
  })();
  return shutdownPromise;
}

stopNodeBackofficeOnSupervisorDisconnect("server", shutdownNodeBackofficeServer);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void shutdownNodeBackofficeServer().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Node Backoffice shutdown failed", error);
        process.exit(1);
      },
    );
  });
}
