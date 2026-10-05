import { startAuthorityBoundGraftNodeObjectHost } from "@fragno-private/backoffice-node-runtime/node-object-runtime-host";

import { createNodeApp } from "./node/node-app";
import { createNodeInternalApp } from "./node/node-internal-app";
import { nodeReadyMessageKind } from "./node/node-ready-message";
import { handleNodeFetchFailure } from "./node/node-request-boundary";
import { demoObjectDefinition } from "./objects/demo-object-definition";
import {
  readServingGraftStorage,
  requireDemoEnvironment,
} from "./storage/configured-graft-storage";

const NODE_PEER_WEBSOCKET_PATH = "/__node-object-peer";
const config = await readNodeServerConfig();
const host = await startAuthorityBoundGraftNodeObjectHost({
  storage: config.storage,
  clock: { kind: "system" },
  identity: { kind: "generated", compatibilityVersion: config.compatibilityVersion },
  leasePolicy: {
    leaseDurationMs: config.leaseDurationMs,
    renewalIntervalMs: 1_000,
    renewalRetryIntervalMs: 250,
    selfFenceSafetyMarginMs: 1_000,
    maximumClockSkewMs: 100,
  },
  peerRpc: {
    authenticationSecret: config.peerAuthenticationSecret,
    authenticationWindowMs: 5_000,
  },
  objectProvisioning: { kind: "lazy" },
  objectEviction: {
    kind: "automatic",
    idleTimeoutMs: config.objectIdleTimeoutMs,
    sweepIntervalMs: config.objectEvictionSweepIntervalMs,
    reportError(error) {
      console.error("DEMO_OBJECT_EVICTION_SWEEP_FAILED", error);
    },
  },
  objects: { SHOWCASE: demoObjectDefinition },
  network: {
    application: {
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      resolveOrigin(boundPort) {
        return config.advertisement.kind === "explicit"
          ? config.advertisement.applicationOrigin
          : `http://${config.listenHost}:${boundPort}`;
      },
    },
    internal: {
      listenHost: config.internalListenHost,
      listenPort: config.internalListenPort,
      peerWebSocketPath: NODE_PEER_WEBSOCKET_PATH,
      peerWebSocketMaximumPayloadBytes: 1_048_576,
      resolveOrigin(boundPort) {
        return config.advertisement.kind === "explicit"
          ? config.advertisement.internalOrigin
          : `http://${config.internalListenHost}:${boundPort}`;
      },
    },
  },
  alarmPolling: {
    kind: "automatic",
    intervalMs: config.alarmIntervalMs,
    reportError(error) {
      console.error("DEMO_ALARM_TICK_FAILED", error);
    },
  },
  createApplications({ runtime, nodeIdentity, applicationOrigin }) {
    const application = createNodeApp({ runtime });
    const internal = createNodeInternalApp({
      runtime,
      storage: config.storage,
      nodeId: nodeIdentity.nodeId,
      applicationOrigin,
    });
    return {
      application: {
        fetch: (request) => application.fetch(request),
        handleFetchFailure: handleNodeFetchFailure,
      },
      internal: {
        fetch: (request) => internal.fetch(request),
        handleFetchFailure: handleNodeFetchFailure,
      },
    };
  },
});
let shutdown: Promise<void> | null = null;

const readyLog = {
  applicationOrigin: host.applicationOrigin,
  internalOrigin: host.internalOrigin,
  peerWebSocketAddress: host.peerWebSocketAddress,
  graftConfigPath: config.storage.configPath,
  controlRemoteLogId: config.storage.controlRemoteLogId,
  nodeId: host.nodeIdentity.nodeId,
  processGeneration: host.nodeIdentity.processGeneration,
  nodeAuthority: host.runtime.readNodeAuthorityStatus(),
};
console.log(`DEMO_NODE_READY:${JSON.stringify(readyLog)}`);
console.log(
  `Runtime demo application listening at ${host.applicationOrigin}; internal at ${host.internalOrigin}`,
);
process.send?.({
  kind: nodeReadyMessageKind,
  applicationOrigin: readyLog.applicationOrigin,
  internalOrigin: readyLog.internalOrigin,
  peerWebSocketAddress: readyLog.peerWebSocketAddress,
  nodeId: readyLog.nodeId,
  processGeneration: readyLog.processGeneration,
});

process.once("SIGINT", () => {
  void stopNodeServer("SIGINT");
});
process.once("SIGTERM", () => {
  void stopNodeServer("SIGTERM");
});

async function stopNodeServer(signal: string): Promise<void> {
  shutdown ??= (async () => {
    console.log(`Runtime demo stopping after ${signal}`);
    await host.close({ maximumDrainDurationMs: 8_000 });
  })();
  try {
    await shutdown;
    process.exitCode = 0;
  } catch (error) {
    console.error("DEMO_SHUTDOWN_FAILED", error);
    process.exitCode = 1;
  }
}

async function readNodeServerConfig() {
  const storage = await readServingGraftStorage(process.env);
  const peerAuthenticationSecret = requireDemoEnvironment(
    process.env,
    "BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET",
  );
  if (peerAuthenticationSecret.length < 32) {
    throw new Error("DEMO_PEER_AUTHENTICATION_SECRET_TOO_SHORT");
  }
  const listenHost =
    process.env["HOST"] ?? process.env["BACKOFFICE_NODE_RUNTIME_DEMO_HOST"] ?? "127.0.0.1";
  if (listenHost.length === 0) {
    throw new Error("DEMO_NODE_LISTEN_HOST_EMPTY");
  }
  const listenPort = readEnvironmentInteger(
    "PORT",
    readEnvironmentInteger("BACKOFFICE_NODE_RUNTIME_DEMO_PORT", 3210, 0),
    0,
  );
  const internalListenHost =
    process.env["BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_HOST"] ?? listenHost;
  const internalListenPort = readEnvironmentInteger(
    "BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT",
    3211,
    0,
  );
  return {
    storage,
    listenHost,
    listenPort,
    internalListenHost,
    internalListenPort,
    advertisement: readNodeNetworkAdvertisement(process.env, listenHost, internalListenHost),
    compatibilityVersion: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_COMPATIBILITY_VERSION",
      1,
      1,
    ),
    alarmIntervalMs: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS",
      1_000,
      1,
    ),
    leaseDurationMs: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS",
      10_000,
      2_001,
    ),
    objectEvictionSweepIntervalMs: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_OBJECT_EVICTION_SWEEP_INTERVAL_MS",
      5_000,
      1,
    ),
    objectIdleTimeoutMs: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_OBJECT_IDLE_TIMEOUT_MS",
      60_000,
      1,
    ),
    peerAuthenticationSecret,
  };
}

type NodeNetworkAdvertisement =
  | { kind: "explicit"; applicationOrigin: string; internalOrigin: string }
  | { kind: "derived" };

function readNodeNetworkAdvertisement(
  environment: NodeJS.ProcessEnv,
  listenHost: string,
  internalListenHost: string,
): NodeNetworkAdvertisement {
  const applicationOrigin =
    environment["BACKOFFICE_NODE_RUNTIME_DEMO_APPLICATION_ORIGIN"]?.trim() || null;
  const internalOrigin =
    environment["BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_ORIGIN"]?.trim() || null;
  if (applicationOrigin !== null || internalOrigin !== null) {
    if (applicationOrigin === null || internalOrigin === null) {
      throw new Error("DEMO_NODE_ADVERTISED_ADDRESSES_INCOMPLETE");
    }
    // The runtime host validates and canonicalizes advertised origins before registration.
    return { kind: "explicit", applicationOrigin, internalOrigin };
  }
  if (
    [listenHost, internalListenHost].some(
      (host) => host.length === 0 || ["0.0.0.0", "::"].includes(host),
    )
  ) {
    throw new Error("DEMO_NODE_ADVERTISED_ADDRESSES_REQUIRED");
  }
  return { kind: "derived" };
}

function readEnvironmentInteger(name: string, fallback: number, minimum: number): number {
  const source = process.env[name];
  if (source === undefined) {
    return fallback;
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`DEMO_ENVIRONMENT_INTEGER_INVALID:${name}`);
  }
  return value;
}
