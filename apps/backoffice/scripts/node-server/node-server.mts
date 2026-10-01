import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import type { ServerBuild } from "react-router";

import { createRequestHandler } from "@react-router/express";

import { BackofficeKernel } from "../../app/backoffice-runtime/kernel";
import { createLocalBackofficeRuntime } from "../../app/backoffice-runtime/node/local-runtime";
import { createExternallyProcessedNodeBackofficeDurableHooks } from "../../app/backoffice-runtime/node/node-durable-hooks";
import { shutdownNodeOpenTelemetry } from "../../app/backoffice-runtime/node/node-opentelemetry-lifecycle";
import { createBackofficeRouterContextProvider } from "../../app/worker-runtime/router-context-provider.server";
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
import { registerNodeBackofficeWorkerSourceMaps } from "./node-worker-source-maps";

const serverBuild = (await import(
  new URL("./server/index.js", import.meta.url).href
)) as ServerBuild;

const config = await createNodeBackofficeProcessConfig();
const runtime = await createLocalBackofficeRuntime({
  sqliteDataDirectory: config.sqliteDataDirectory,
  runtimeEnv: config.runtimeEnv,
  workerTypeChecker: config.workerTypeChecker,
  createSandboxProviders: config.createSandboxProviders,
  durableHooks: createExternallyProcessedNodeBackofficeDurableHooks(),
});
const kernel = new BackofficeKernel(runtime.services);
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
registerNodeBackofficeWorkerSourceMaps(app, process.env.NODE_ENV === "development");
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
app.use(
  createRequestHandler({
    build: serverBuild,
    mode: "production",
    getLoadContext(request, response) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            headers.append(name, entry);
          }
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) {
          controller.abort();
        }
      });
      // The adapter owns the request body; request state only needs URL, headers, and cancellation.
      const contextRequest = new Request(
        new URL(`${request.protocol}://${request.host}${request.originalUrl}`),
        { method: request.method, headers, signal: controller.signal },
      );
      return createBackofficeRouterContextProvider(contextRequest, {
        runtime: runtime.services,
        kernel,
        env: runtime.env as unknown as CloudflareEnv,
        ctx: {
          waitUntil: (promise: Promise<unknown>) => void promise.catch(console.error),
        } as ExecutionContext,
      });
    },
  }),
);

const listeners = await startNodeBackofficeListeners({
  requestListener(request, response) {
    app(request, response);
  },
  hosts: config.listenHosts,
  port: config.port,
}).catch(async (error: unknown) => {
  try {
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
      console.info("Node Backoffice server HTTP listeners closed: cleaning up runtime");
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
