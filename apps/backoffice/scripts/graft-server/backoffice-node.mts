import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAuthorityBoundGraftNodeObjectHost } from "@fragno-private/backoffice-node-runtime/node-object-runtime-host";
import type { ServerBuild } from "react-router";

import { defineGraftBackofficeObjects } from "../../app/backoffice-runtime/node/graft-object-definitions";
import { createGraftBackofficeRuntimeServices } from "../../app/backoffice-runtime/node/graft-runtime-services";
import { shutdownNodeOpenTelemetry } from "../../app/backoffice-runtime/node/node-opentelemetry-lifecycle";
import { stopNodeBackofficeOnSupervisorDisconnect } from "../node-server/node-supervisor-disconnect";
import { createGraftBackofficeProcessConfig } from "./graft-process-config";
import { createNodeGraftBackofficeApplication } from "./node-graft-application";
import { resolveNodeBackofficeGraftStorage } from "./node-graft-storage";

const serverBuild = (await import(
  new URL("./server/index.js", import.meta.url).href
)) as ServerBuild;
const config = createGraftBackofficeProcessConfig();
const storage = await resolveNodeBackofficeGraftStorage(process.env);
const configuration = config.configuration;
const objects = defineGraftBackofficeObjects(
  new URL("./graft-backoffice-objects.mjs", import.meta.url),
  configuration,
);
const listenHost = config.listenHost;
const internalHost = process.env.BACKOFFICE_NODE_INTERNAL_HOST ?? "127.0.0.1";
const internalPort = Number(process.env.BACKOFFICE_NODE_INTERNAL_PORT ?? 5174);
if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65_535) {
  throw new Error("BACKOFFICE_NODE_INTERNAL_PORT_INVALID");
}
const applicationOrigin = requireNodeBackofficeAdvertisedOrigin(
  "BACKOFFICE_NODE_APPLICATION_ORIGIN",
  listenHost,
  config.port,
);
const internalOrigin = requireNodeBackofficeAdvertisedOrigin(
  "BACKOFFICE_NODE_INTERNAL_ORIGIN",
  internalHost,
  internalPort,
);
const host = await startAuthorityBoundGraftNodeObjectHost({
  storage,
  objects,
  clock: { kind: "system" },
  identity: { kind: "generated", compatibilityVersion: 1 },
  leasePolicy: {
    leaseDurationMs: 60_000,
    renewalIntervalMs: 10_000,
    renewalRetryIntervalMs: 1_000,
    selfFenceSafetyMarginMs: 5_000,
    maximumClockSkewMs: 100,
  },
  peerRpc: {
    authenticationSecret: configuration.env.BACKOFFICE_INTERNAL_REQUEST_SECRET,
    authenticationWindowMs: 5_000,
  },
  objectProvisioning: { kind: "lazy" },
  objectEviction: {
    kind: "automatic",
    idleTimeoutMs: 60_000,
    sweepIntervalMs: 5_000,
    reportError: (error) => {
      console.error("BACKOFFICE_OBJECT_EVICTION_FAILED", error);
    },
  },
  network: {
    application: {
      listenHost,
      listenPort: config.port,
      resolveOrigin: () => applicationOrigin,
    },
    internal: {
      listenHost: internalHost,
      listenPort: internalPort,
      resolveOrigin: () => internalOrigin,
      peerWebSocketPath: "/__node-object-peer",
      peerWebSocketMaximumPayloadBytes: 1_048_576,
    },
  },
  alarmPolling: {
    kind: "automatic",
    intervalMs: 300,
    reportError: (error) => {
      console.error("BACKOFFICE_OBJECT_ALARM_FAILED", error);
    },
  },
  createApplications({ runtime }) {
    const { env, services } = createGraftBackofficeRuntimeServices({
      configuration,
      resolve: (binding, name) => runtime.objects[binding].get(name) as never,
      nowEpochMs: Date.now,
    });
    return {
      application: createNodeGraftBackofficeApplication({
        serverBuild,
        services,
        env,
        staticDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "client"),
        publicBaseUrl: config.publicBaseUrl,
        trustedProxy: process.env.BACKOFFICE_TRUST_PROXY ?? "loopback",
        development: process.env.NODE_ENV === "development",
      }),
      internal: {
        fetch: () => Response.json({ code: "NOT_FOUND" }, { status: 404 }),
        handleFetchFailure: (error) => {
          console.error("BACKOFFICE_INTERNAL_REQUEST_FAILED", error);
          return Response.json({ code: "INTERNAL_ERROR" }, { status: 500 });
        },
      },
    };
  },
}).catch(async (error: unknown) => {
  await shutdownNodeOpenTelemetry();
  throw error;
});
console.info(
  `Backoffice listening at ${host.applicationOrigin}; internal peer ingress at ${host.internalOrigin}`,
);

let shutdown: Promise<void> | null = null;
function shutdownNodeBackoffice(): Promise<void> {
  shutdown ??= (async () => {
    try {
      await host.close({ maximumDrainDurationMs: 8_000 });
    } finally {
      await shutdownNodeOpenTelemetry();
    }
  })();
  return shutdown;
}
stopNodeBackofficeOnSupervisorDisconnect("server", shutdownNodeBackoffice);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void shutdownNodeBackoffice().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("BACKOFFICE_GRAFT_SHUTDOWN_FAILED", error);
        process.exit(1);
      },
    );
  });
}

function requireNodeBackofficeAdvertisedOrigin(
  name: string,
  listenHost: string,
  port: number,
): string {
  const configured = process.env[name]?.trim();
  if (configured) {
    return configured;
  }
  if (["0.0.0.0", "::"].includes(listenHost)) {
    throw new Error(`BACKOFFICE_NODE_ADVERTISED_ORIGIN_REQUIRED:${name}`);
  }
  return `http://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${port}`;
}
