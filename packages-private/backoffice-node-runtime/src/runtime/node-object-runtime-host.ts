import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { createAdaptorServer } from "@hono/node-server";

import type { GraftNodeLeasePolicy, GraftRuntimeNodeIdentity } from "../graft/graft-node-authority";
import type { GraftObjectProvisioningPolicy } from "../graft/graft-object-provisioning";
import type { GraftNodeRuntimeStorage } from "../graft/graft-runtime-storage";
import type { NodePeerRpcConfig } from "../rpc/node-peer-rpc";
import {
  attachNodePeerWebSocketServer,
  type NodePeerWebSocketServer,
} from "../rpc/node-peer-websocket-server";
import {
  startNodeBackofficeAlarmScheduler,
  type NodeBackofficeAlarmScheduler,
} from "../scheduling/node-alarm-scheduler";
import {
  createAuthorityBoundGraftNodeObjectRuntime,
  type AuthorityBoundGraftNodeObjectRuntime,
  type NodeObjectActivationEvictionPolicy,
} from "./node-object-runtime";
import type { NodeRuntimeClock } from "./node-runtime-clock";
import type { NodeRuntimeObjectBindings } from "./node-runtime-object";
import { nodeRuntimeReadinessPath, type NodeRuntimeReadiness } from "./node-runtime-readiness";

const MAX_NODE_OBJECT_RUNTIME_HOST_DRAIN_DURATION_MS = 2_147_483_647;

/** Supplies a fresh production incarnation or an exact deterministic identity for scenarios. */
export type NodeObjectRuntimeHostIdentity =
  | { kind: "generated"; compatibilityVersion: number }
  | {
      kind: "exact";
      nodeId: string;
      processGeneration: string;
      compatibilityVersion: number;
    };

/** Selects automatic resident-object alarm polling or caller-driven ticks. */
export type NodeObjectRuntimeHostAlarmPolling =
  | {
      kind: "automatic";
      intervalMs: number;
      reportError(error: unknown): void;
    }
  | { kind: "manual" };

/** A Fetch handler and its failure mapper; only application ingress receives an automatic output gate. */
export type NodeObjectRuntimeHostApplication = {
  fetch(request: Request): Response | Promise<Response>;
  /** Builds a response without object RPC after application execution or durability fails. */
  handleFetchFailure(error: unknown, request: Request): Response | Promise<Response>;
};

/** Separate HTTP surfaces: internal handlers must explicitly gate any object mutations they perform. */
export type NodeObjectRuntimeHostApplications = {
  application: NodeObjectRuntimeHostApplication;
  internal: NodeObjectRuntimeHostApplication;
};

type NodeObjectRuntimeHostListener = {
  listenHost: string;
  listenPort: number;
  resolveOrigin(boundPort: number): string;
};

/** Values available after both listeners bind and the authority-bound runtime is serving. */
export type NodeObjectRuntimeHostApplicationContext<TBindings extends NodeRuntimeObjectBindings> = {
  runtime: AuthorityBoundGraftNodeObjectRuntime<TBindings>;
  nodeIdentity: GraftRuntimeNodeIdentity;
  applicationOrigin: string;
  internalOrigin: string;
  peerWebSocketAddress: string;
};

/** Configures one runtime-owned Node HTTP process shell and its authority-bound object runtime. */
export type AuthorityBoundGraftNodeObjectHostOptions<TBindings extends NodeRuntimeObjectBindings> =
  {
    storage: GraftNodeRuntimeStorage;
    objects: TBindings;
    clock: NodeRuntimeClock;
    identity: NodeObjectRuntimeHostIdentity;
    leasePolicy: GraftNodeLeasePolicy;
    peerRpc: NodePeerRpcConfig;
    objectProvisioning: GraftObjectProvisioningPolicy;
    objectEviction: NodeObjectActivationEvictionPolicy;
    network: {
      application: NodeObjectRuntimeHostListener;
      internal: NodeObjectRuntimeHostListener & {
        peerWebSocketPath: string;
        peerWebSocketMaximumPayloadBytes: number;
      };
    };
    alarmPolling: NodeObjectRuntimeHostAlarmPolling;
    createApplications(
      context: NodeObjectRuntimeHostApplicationContext<TBindings>,
    ): NodeObjectRuntimeHostApplications;
  };

/** Bounds caller-visible host draining while unfinished cleanup remains fenced from new admission. */
export type NodeObjectRuntimeHostCloseOptions = {
  maximumDrainDurationMs: number;
};

/** Owns both listeners, internal-only peer ingress, alarms, runtime, and idempotent cleanup. */
export type AuthorityBoundGraftNodeObjectHost<TBindings extends NodeRuntimeObjectBindings> =
  NodeObjectRuntimeHostApplicationContext<TBindings> & {
    /**
     * Stops admission and waits within the supplied duration for active Fetch handlers and cleanup.
     * Callers must still settle work that outlives a returned Response, including streams and capabilities.
     */
    close(options: NodeObjectRuntimeHostCloseOptions): Promise<void>;
  };

type NodeObjectRuntimeHostLifecycle = "starting" | "serving" | "draining" | "closed";

/** Starts the reusable Node process shell for one stateless Graft runtime container. */
export async function startAuthorityBoundGraftNodeObjectHost<
  TBindings extends NodeRuntimeObjectBindings,
>(
  options: AuthorityBoundGraftNodeObjectHostOptions<TBindings>,
): Promise<AuthorityBoundGraftNodeObjectHost<TBindings>> {
  validateNodeObjectRuntimeHostOptions(options);
  let lifecycle: NodeObjectRuntimeHostLifecycle = "starting";
  let applications: NodeObjectRuntimeHostApplications | null = null;
  const activeRequests = new Set<Promise<void>>();
  let runtime: AuthorityBoundGraftNodeObjectRuntime<TBindings> | null = null;
  let alarmScheduler: NodeBackofficeAlarmScheduler | null = null;

  const applicationServer = createAdaptorServer({
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === nodeRuntimeReadinessPath && request.method === "GET") {
        const authority = runtime?.readNodeAuthorityStatus();
        const readiness: NodeRuntimeReadiness =
          lifecycle === "serving" && authority?.state === "serving"
            ? {
                status: "ready",
                nodeId: authority.window.nodeId,
                processGeneration: authority.window.processGeneration,
              }
            : { status: "not-ready" };
        return createNodeObjectRuntimeHostReadinessResponse(readiness);
      }
      if (pathname === "/_runtime" || pathname.startsWith("/_runtime/")) {
        return Response.json(
          { error: "NODE_OBJECT_RUNTIME_HOST_ROUTE_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (lifecycle !== "serving" || !applications || !runtime) {
        return Response.json(
          {
            error:
              lifecycle === "starting"
                ? "NODE_OBJECT_RUNTIME_HOST_STARTING"
                : "NODE_OBJECT_RUNTIME_HOST_DRAINING",
          },
          { status: 503 },
        );
      }
      const activeApplication = applications.application;
      const activeRuntime = runtime;
      const operation = runNodeObjectRuntimeHostApplicationFetch({
        application: activeApplication,
        runtime: activeRuntime,
        request,
      });
      return await trackRequest(operation);
    },
  }) as HttpServer;
  // No automatic authority admission or output gate here: fenced nodes must remain inspectable.
  const internalServer = createAdaptorServer({
    async fetch(request) {
      if (lifecycle !== "serving" || !applications) {
        return Response.json({ error: "NODE_OBJECT_RUNTIME_HOST_NOT_READY" }, { status: 503 });
      }
      const internal = applications.internal;
      return await trackRequest(
        Promise.resolve()
          .then(() => internal.fetch(request))
          .catch((error: unknown) => internal.handleFetchFailure(error, request)),
      );
    },
  }) as HttpServer;
  // This listener never accepts peer upgrades, even when an application uses the same HTTP path.
  applicationServer.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => {
      socket.destroy();
    });
  });
  for (const server of [applicationServer, internalServer]) {
    server.prependListener("request", (_request, response) => {
      function closeIdleConnectionsAfterRuntimeHostResponse(): void {
        if (lifecycle === "draining") {
          server.closeIdleConnections();
        }
      }
      response.once("finish", closeIdleConnectionsAfterRuntimeHostResponse);
      response.once("close", closeIdleConnectionsAfterRuntimeHostResponse);
    });
  }

  function trackRequest(operation: Promise<Response>): Promise<Response> {
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    activeRequests.add(tracked);
    void tracked.finally(() => {
      activeRequests.delete(tracked);
    });
    return operation;
  }

  const peerWebSocketServer: NodePeerWebSocketServer = attachNodePeerWebSocketServer({
    server: internalServer,
    path: options.network.internal.peerWebSocketPath,
    maximumPayloadBytes: options.network.internal.peerWebSocketMaximumPayloadBytes,
    acceptWebSocket(webSocket) {
      if (lifecycle !== "serving" || !runtime) {
        throw new Error("NODE_OBJECT_RUNTIME_HOST_NOT_READY");
      }
      runtime.acceptNodePeerWebSocket(webSocket);
    },
  });

  let closeOperation: Promise<void> | null = null;
  try {
    const applicationPort = await listenNodeObjectRuntimeHostServer(
      applicationServer,
      options.network.application.listenHost,
      options.network.application.listenPort,
    );
    const internalPort = await listenNodeObjectRuntimeHostServer(
      internalServer,
      options.network.internal.listenHost,
      options.network.internal.listenPort,
    );
    const applicationOrigin = requireNodeObjectRuntimeHostOrigin(
      options.network.application.resolveOrigin(applicationPort),
    );
    const internalOrigin = requireNodeObjectRuntimeHostOrigin(
      options.network.internal.resolveOrigin(internalPort),
    );
    if (applicationOrigin === internalOrigin) {
      throw new Error("NODE_OBJECT_RUNTIME_HOST_ORIGINS_NOT_DISTINCT");
    }
    const peerAddress = new URL(internalOrigin);
    peerAddress.protocol = peerAddress.protocol === "https:" ? "wss:" : "ws:";
    peerAddress.pathname = options.network.internal.peerWebSocketPath;
    if (
      peerAddress.pathname !== options.network.internal.peerWebSocketPath ||
      peerAddress.pathname.startsWith("//")
    ) {
      throw new Error("NODE_OBJECT_RUNTIME_HOST_PEER_ADDRESS_INVALID");
    }
    const peerWebSocketAddress = peerAddress.href;
    const nodeIdentity = createNodeObjectRuntimeHostIdentity(
      options.identity,
      applicationOrigin,
      peerWebSocketAddress,
    );
    runtime = createAuthorityBoundGraftNodeObjectRuntime({
      storage: options.storage,
      objects: options.objects,
      clock: options.clock,
      nodeIdentity,
      leasePolicy: options.leasePolicy,
      peerRpc: options.peerRpc,
      objectProvisioning: options.objectProvisioning,
      objectEviction: options.objectEviction,
    });
    const context: NodeObjectRuntimeHostApplicationContext<TBindings> = {
      runtime,
      nodeIdentity,
      applicationOrigin,
      internalOrigin,
      peerWebSocketAddress,
    };
    applications = options.createApplications(context);
    const alarmPolling = options.alarmPolling;
    if (alarmPolling.kind === "automatic") {
      alarmScheduler = startNodeBackofficeAlarmScheduler(runtime, {
        intervalMs: alarmPolling.intervalMs,
        onError(error) {
          alarmPolling.reportError(error);
        },
      });
    }
    lifecycle = "serving";

    return {
      ...context,
      close(closeOptions) {
        validateNodeObjectRuntimeHostCloseOptions(closeOptions);
        closeOperation ??= closeNodeObjectRuntimeHost({
          applicationServer,
          internalServer,
          peerWebSocketServer,
          runtime: context.runtime,
          alarmScheduler,
          activeRequests,
          beginDrain() {
            lifecycle = "draining";
            applications = null;
          },
          finishClose() {
            lifecycle = "closed";
          },
        });
        return waitForNodeObjectRuntimeHostClose(
          closeOperation,
          closeOptions.maximumDrainDurationMs,
        );
      },
    };
  } catch (error) {
    lifecycle = "draining";
    applications = null;
    const cleanupFailures: unknown[] = [];
    if (alarmScheduler) {
      await collectNodeObjectRuntimeHostCleanupFailure(cleanupFailures, alarmScheduler.stop());
    }
    if (runtime) {
      await collectNodeObjectRuntimeHostCleanupFailure(cleanupFailures, runtime.cleanup());
    }
    await collectNodeObjectRuntimeHostCleanupFailure(cleanupFailures, peerWebSocketServer.close());
    for (const server of [applicationServer, internalServer]) {
      if (server.listening) {
        await collectNodeObjectRuntimeHostCleanupFailure(
          cleanupFailures,
          closeNodeObjectRuntimeHostServer(server),
        );
      }
    }
    lifecycle = "closed";
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "NODE_OBJECT_RUNTIME_HOST_START_FAILED",
      );
    }
    throw error;
  }
}

function createNodeObjectRuntimeHostReadinessResponse(readiness: NodeRuntimeReadiness): Response {
  return Response.json(readiness, {
    status: readiness.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

async function runNodeObjectRuntimeHostApplicationFetch<
  TBindings extends NodeRuntimeObjectBindings,
>(options: {
  application: NodeObjectRuntimeHostApplication;
  runtime: AuthorityBoundGraftNodeObjectRuntime<TBindings>;
  request: Request;
}): Promise<Response> {
  try {
    return await options.runtime.runWithOutputGate(() =>
      options.application.fetch(options.request),
    );
  } catch (error) {
    return await options.application.handleFetchFailure(error, options.request);
  }
}

function waitForNodeObjectRuntimeHostClose(
  closeOperation: Promise<void>,
  maximumDrainDurationMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`NODE_OBJECT_RUNTIME_HOST_CLOSE_DEADLINE_EXCEEDED:${maximumDrainDurationMs}`),
      );
    }, maximumDrainDurationMs);
    void closeOperation.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error as Error);
      },
    );
  });
}

async function closeNodeObjectRuntimeHost(options: {
  applicationServer: HttpServer;
  internalServer: HttpServer;
  peerWebSocketServer: NodePeerWebSocketServer;
  runtime: AuthorityBoundGraftNodeObjectRuntime<NodeRuntimeObjectBindings>;
  alarmScheduler: NodeBackofficeAlarmScheduler | null;
  activeRequests: Set<Promise<void>>;
  beginDrain(): void;
  finishClose(): void;
}): Promise<void> {
  options.beginDrain();
  const failures: unknown[] = [];
  const servers = [options.applicationServer, options.internalServer];
  const serversClosed = servers.map((server) => {
    const closed = collectNodeObjectRuntimeHostCleanupFailure(
      failures,
      closeNodeObjectRuntimeHostServer(server),
    );
    server.closeIdleConnections();
    return closed;
  });
  if (options.alarmScheduler) {
    await collectNodeObjectRuntimeHostCleanupFailure(failures, options.alarmScheduler.stop());
  }
  await Promise.all(options.activeRequests);
  for (const server of servers) {
    server.closeIdleConnections();
  }
  await collectNodeObjectRuntimeHostCleanupFailure(failures, options.runtime.cleanup());
  await collectNodeObjectRuntimeHostCleanupFailure(failures, options.peerWebSocketServer.close());
  await Promise.all(serversClosed);
  options.finishClose();
  if (failures.length > 0) {
    throw new AggregateError(failures, "NODE_OBJECT_RUNTIME_HOST_CLOSE_FAILED");
  }
}

async function listenNodeObjectRuntimeHostServer(
  server: HttpServer,
  host: string,
  port: number,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    function handleListenError(error: Error): void {
      server.off("listening", handleListening);
      reject(error);
    }
    function handleListening(): void {
      server.off("error", handleListenError);
      resolve();
    }
    server.once("error", handleListenError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_ADDRESS_INVALID");
  }
  return address.port;
}

function closeNodeObjectRuntimeHostServer(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function collectNodeObjectRuntimeHostCleanupFailure(
  failures: unknown[],
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    failures.push(error);
  }
}

function createNodeObjectRuntimeHostIdentity(
  identity: NodeObjectRuntimeHostIdentity,
  applicationOrigin: string,
  peerWebSocketAddress: string,
): GraftRuntimeNodeIdentity {
  if (identity.kind === "generated") {
    return {
      nodeId: randomUUID(),
      processGeneration: randomUUID(),
      privateAddress: peerWebSocketAddress,
      applicationOrigin,
      compatibilityVersion: identity.compatibilityVersion,
    };
  }
  return {
    nodeId: identity.nodeId,
    processGeneration: identity.processGeneration,
    privateAddress: peerWebSocketAddress,
    applicationOrigin,
    compatibilityVersion: identity.compatibilityVersion,
  };
}

function validateNodeObjectRuntimeHostCloseOptions(
  options: NodeObjectRuntimeHostCloseOptions,
): void {
  if (
    !Number.isSafeInteger(options.maximumDrainDurationMs) ||
    options.maximumDrainDurationMs <= 0 ||
    options.maximumDrainDurationMs > MAX_NODE_OBJECT_RUNTIME_HOST_DRAIN_DURATION_MS
  ) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_CLOSE_DURATION_INVALID");
  }
}

function validateNodeObjectRuntimeHostOptions(
  options: AuthorityBoundGraftNodeObjectHostOptions<NodeRuntimeObjectBindings>,
): void {
  for (const listener of [options.network.application, options.network.internal]) {
    if (listener.listenHost.length === 0) {
      throw new Error("NODE_OBJECT_RUNTIME_HOST_LISTEN_HOST_INVALID");
    }
    if (
      !Number.isSafeInteger(listener.listenPort) ||
      listener.listenPort < 0 ||
      listener.listenPort > 65_535
    ) {
      throw new Error("NODE_OBJECT_RUNTIME_HOST_LISTEN_PORT_INVALID");
    }
  }
  if (
    !Number.isSafeInteger(options.identity.compatibilityVersion) ||
    options.identity.compatibilityVersion < 0
  ) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_COMPATIBILITY_VERSION_INVALID");
  }
  if (
    options.identity.kind === "exact" &&
    (options.identity.nodeId.length === 0 || options.identity.processGeneration.length === 0)
  ) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_IDENTITY_INVALID");
  }
  if (
    options.alarmPolling.kind === "automatic" &&
    (!Number.isSafeInteger(options.alarmPolling.intervalMs) || options.alarmPolling.intervalMs <= 0)
  ) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_ALARM_INTERVAL_INVALID");
  }
  if (options.network.internal.peerWebSocketPath === nodeRuntimeReadinessPath) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_PEER_PATH_RESERVED");
  }
}

function requireNodeObjectRuntimeHostOrigin(source: string): string {
  let origin: URL;
  try {
    origin = new URL(source);
  } catch (cause) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_ORIGIN_INVALID", { cause });
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new Error("NODE_OBJECT_RUNTIME_HOST_ORIGIN_INVALID");
  }
  return origin.origin;
}
