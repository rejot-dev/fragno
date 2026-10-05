import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";

import { RpcStub, RpcTarget } from "capnweb";

import {
  GraftControlStore,
  type GraftObjectAlarmWork,
  type GraftObjectLocation,
} from "../graft/graft-control-store";
import { releaseGraftControlStoreLock } from "../graft/graft-control-store-lock";
import {
  createSqlitePragmaGraftDatabaseOperations,
  defineGraftDatabaseOperations,
  type GraftDatabaseOperations,
  type GraftRuntimeDatabaseOperations,
} from "../graft/graft-database-operations";
import {
  GraftNodeAuthority,
  type GraftRuntimeNodeIdentity,
  type GraftNodeLeasePolicy,
  type GraftNodeAuthorityStatus,
  type GraftNodeAuthorityWindow,
} from "../graft/graft-node-authority";
import { DEFAULT_GRAFT_OBJECT_ACTIVATION_FENCE_ATTEMPTS } from "../graft/graft-object-activation";
import type { GraftObjectAuthority } from "../graft/graft-object-authority";
import {
  provisionGraftObject,
  type GraftObjectProvisioningPolicy,
} from "../graft/graft-object-provisioning";
import type { GraftNodeRuntimeStorage } from "../graft/graft-runtime-storage";
import { createNodeMessagePortRpcSession } from "../rpc/node-message-port-rpc";
import { createNodePeerForwardingTarget } from "../rpc/node-peer-object-forwarder";
import {
  NodePeerRpcNetwork,
  type NodePeerObjectRoute,
  type NodePeerRpcConfig,
} from "../rpc/node-peer-rpc";
import {
  createNodePeerObjectRoute,
  isPreDeliveryObjectClaimRace,
  isPreDeliveryPeerRouteRefusal,
  requireExpectedLocalPeerRoute,
  shouldAttemptLocalObjectActivation,
  type NodeObjectPeerRouting,
} from "./node-object-peer-routing";
import type { NodeObjectWorkerControl, NodeObjectWorkerOptions } from "./node-object-worker";
import {
  readNodeRuntimeEpochMilliseconds,
  readNodeRuntimeMonotonicMilliseconds,
  type NodeRuntimeClock,
} from "./node-runtime-clock";
import type { NodeRuntimeObjectBindings, NodeRuntimeObjectStub } from "./node-runtime-object";

/** Namespace stubs preserve Cap'n Web's typed methods, capabilities, and promise pipelining. */
export type NodeRuntimeObjects<TBindings extends NodeRuntimeObjectBindings> = {
  [K in keyof TBindings]: { get(name: string): NodeRuntimeObjectStub<TBindings[K]> };
};

/** Configures process-local resident object eviction without deleting durable object state. */
export type NodeObjectActivationEvictionPolicy =
  | { kind: "disabled" }
  | { kind: "manual"; idleTimeoutMs: number }
  | {
      kind: "automatic";
      idleTimeoutMs: number;
      sweepIntervalMs: number;
      reportError(error: unknown): void;
    };

type NodeObjectWorkerPersistence = NodeObjectWorkerOptions["persistence"];

// Node turns overflowing timeout delays into 1 ms; long leases must not spin the watchdog.
const MAX_NODE_AUTHORITY_TIMEOUT_MS = 2_147_483_647;

const defaultGraftDatabaseOperations: GraftRuntimeDatabaseOperations<null> = {
  control: createSqlitePragmaGraftDatabaseOperations(),
  provisioning: createSqlitePragmaGraftDatabaseOperations(),
  worker: defineGraftDatabaseOperations(
    new URL("../graft/graft-database-operations.js", import.meta.url),
    "createSqlitePragmaGraftDatabaseOperations",
    null,
  ),
};

/** Authority-bound runtimes own process lease renewal rather than accepting caller-created leases. */
export type AuthorityBoundGraftNodeObjectRuntimeOptions<
  TBindings extends NodeRuntimeObjectBindings,
> = {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
  nodeIdentity: GraftRuntimeNodeIdentity;
  leasePolicy: GraftNodeLeasePolicy;
  peerRpc: NodePeerRpcConfig;
  objectProvisioning: GraftObjectProvisioningPolicy;
  objectEviction: NodeObjectActivationEvictionPolicy;
};

/** Owns object workers, output gates, alarms, and caller-coordinated cleanup. */
export type NodeObjectRuntime<TBindings extends NodeRuntimeObjectBindings> = ReturnType<
  typeof createGraftObjectWorkerRuntime<TBindings>
>["runtime"];

/** Adds inspection of the process's renewable, terminally self-fencing node authority. */
export type AuthorityBoundGraftNodeObjectRuntime<TBindings extends NodeRuntimeObjectBindings> =
  NodeObjectRuntime<TBindings> & {
    readNodeAuthorityStatus(): GraftNodeAuthorityStatus;
    acceptNodePeerWebSocket(webSocket: WebSocket): void;
  };

type RuntimeNodeAuthority = {
  controller: GraftNodeAuthority;
  releaseObject(authority: GraftObjectAuthority): void;
};

function throwObjectRuntimeFailures(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
) {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

/** Owns workers admitted only after a durable control claim and object-log fencing commit. */
export function createAuthorityBoundGraftNodeObjectRuntime<
  TBindings extends NodeRuntimeObjectBindings,
>(
  options: AuthorityBoundGraftNodeObjectRuntimeOptions<TBindings>,
): AuthorityBoundGraftNodeObjectRuntime<TBindings> {
  return createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations({
    ...options,
    databaseOperations: defaultGraftDatabaseOperations,
  });
}

/** Owns authority-bound Graft workers using explicit control and object-log management operations. */
export function createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations<
  TBindings extends NodeRuntimeObjectBindings,
>(
  options: AuthorityBoundGraftNodeObjectRuntimeOptions<TBindings> & {
    databaseOperations: GraftRuntimeDatabaseOperations;
  },
): AuthorityBoundGraftNodeObjectRuntime<TBindings> {
  validateNodeRuntimeObjectBindings(options.objects);
  validateGraftObjectProvisioningPolicy(options.objectProvisioning);
  validateNodeObjectActivationEvictionPolicy(options.objectEviction);
  const controlStore = new GraftControlStore(options.storage, options.databaseOperations.control);
  const maximumClockSkewMs = options.leasePolicy.maximumClockSkewMs;
  let controller: GraftNodeAuthority;
  try {
    controller = new GraftNodeAuthority({
      controlStore,
      clock: options.clock,
      identity: options.nodeIdentity,
      policy: options.leasePolicy,
    });
  } catch (error) {
    controlStore.close();
    throw error;
  }
  let getLocalObjectForPeer:
    | ((route: NodePeerObjectRoute, assertPeerAuthority: () => void) => Promise<RpcTarget>)
    | null = null;
  const peerNetwork = new NodePeerRpcNetwork({
    controlStore,
    maximumClockSkewMs,
    clock: options.clock,
    identity: options.nodeIdentity,
    config: options.peerRpc,
    provider: {
      async getLocalObjectForPeer(route, assertPeerAuthority) {
        if (!getLocalObjectForPeer) {
          throw new Error("NODE_OBJECT_RUNTIME_PEER_PROVIDER_NOT_READY");
        }
        return await getLocalObjectForPeer(route, assertPeerAuthority);
      },
    },
  });
  let alarmWorkCursor = "";
  const result = createGraftObjectWorkerRuntime({
    objects: options.objects,
    clock: options.clock,
    nodeAuthority: {
      controller,
      releaseObject(authority) {
        controller.requireServingWindow();
        const nowEpochMs = readNodeRuntimeEpochMilliseconds(options.clock);
        const result = controlStore.releaseObject({
          commandId: randomUUID(),
          commandCreatedAtMs: nowEpochMs,
          input: {
            objectId: authority.objectId,
            epoch: authority.epoch,
            nodeId: authority.ownerNodeId,
            processGeneration: authority.processGeneration,
            claimId: authority.claimId,
            attemptedAtMs: nowEpochMs,
          },
        });
        controller.requireServingWindow();
        if (result.outcome !== "released" && result.outcome !== "ownership-changed") {
          throw new Error(`GRAFT_NODE_RUNTIME_RELEASE_REJECTED:${result.outcome}`);
        }
      },
    },
    peerRouting: {
      identity: { ...options.nodeIdentity },
      maximumClockSkewMs,
      readObjectRoutingState(objectId) {
        return controlStore.readObjectRoutingState(objectId);
      },
      ensureObjectProvisioned(objectId) {
        resolveGraftObjectLocation({
          objectId,
          storage: options.storage,
          controlStore,
          clock: options.clock,
          policy: options.objectProvisioning,
          databaseOperations: options.databaseOperations.provisioning,
        });
      },
      async getRemoteObject(route) {
        return await peerNetwork.getRemoteObject(route);
      },
    },
    objectEviction: options.objectEviction,
    readServiceableAlarmWork(nowEpochMs) {
      const work = controlStore.readServiceableObjectAlarmWork({
        nodeId: options.nodeIdentity.nodeId,
        processGeneration: options.nodeIdentity.processGeneration,
        dueAtOrBeforeMs: nowEpochMs,
        ownerLeaseExpiryCutoffMs: Math.max(0, nowEpochMs - maximumClockSkewMs),
        afterObjectId: alarmWorkCursor,
        limit: 100,
      });
      alarmWorkCursor = work.length === 100 ? work[work.length - 1].objectId : "";
      return work;
    },
    resolveObject(binding, name) {
      const objectId = `${binding}:${name}`;
      const location = controlStore.readObjectLocation(objectId);
      if (!location) {
        throw new Error(`NODE_OBJECT_RUNTIME_OBJECT_NOT_PROVISIONED:${objectId}`);
      }
      return {
        remoteLogId: location.remoteLogId,
        operations: options.databaseOperations.worker,
        storage: options.storage,
        nodeAuthority: controller.requireServingWindow(),
        maximumClockSkewMs,
        maxFenceAttempts: DEFAULT_GRAFT_OBJECT_ACTIVATION_FENCE_ATTEMPTS,
      };
    },
  });
  getLocalObjectForPeer = result.getLocalObjectForPeer;
  let cleanup: Promise<void> | null = null;
  return {
    ...result.runtime,
    readNodeAuthorityStatus: result.readNodeAuthorityStatus,
    acceptNodePeerWebSocket(webSocket) {
      peerNetwork.acceptWebSocket(webSocket);
    },
    cleanup() {
      cleanup ??= (async () => {
        peerNetwork.close();
        await result.runtime.cleanup();
      })();
      return cleanup;
    },
  };
}

/**
 * Owns one worker per object identity; serving requests and processing alarms share an instance.
 * Callers must finish application RPC and stop scheduling work before cleanup.
 */
function createGraftObjectWorkerRuntime<TBindings extends NodeRuntimeObjectBindings>(options: {
  resolveObject(binding: string, name: string): NodeObjectWorkerPersistence;
  objects: TBindings;
  clock: NodeRuntimeClock;
  nodeAuthority: RuntimeNodeAuthority;
  peerRouting: NodeObjectPeerRouting;
  readServiceableAlarmWork(nowEpochMs: number): GraftObjectAlarmWork[];
  objectEviction: NodeObjectActivationEvictionPolicy;
}) {
  const workers = new Map<string, ReturnType<typeof startObjectWorker>>();
  const idleEvictions = new Map<string, Promise<void>>();
  const activeOutputScope = new AsyncLocalStorage<ReturnType<typeof createRuntimeOutputScope>>();
  let closed = false;
  let cleanup: Promise<void> | null = null;
  let objectEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  let objectEvictionSweep: Promise<void> | null = null;
  let authorityTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let authorityFenced = false;
  let authoritySchedulingClosed = false;

  function readNodeAuthorityStatus(): GraftNodeAuthorityStatus {
    const status = options.nodeAuthority.controller.readStatus();
    if (status.state === "fenced") {
      retireNodeAuthority();
    }
    return status;
  }

  function retireNodeAuthority() {
    if (authorityFenced) {
      return;
    }
    authorityFenced = true;
    if (authorityTimer) {
      clearTimeout(authorityTimer);
      authorityTimer = null;
    }
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    for (const worker of workers.values()) {
      worker.retire();
    }
  }

  function requireOpen() {
    if (closed) {
      throw new Error("NODE_OBJECT_RUNTIME_CLOSED");
    }
    if (readNodeAuthorityStatus().state !== "serving") {
      throw new Error("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
    }
  }

  function scheduleAuthorityDeadline() {
    if (options.clock.kind !== "system" || authoritySchedulingClosed) {
      return;
    }
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    const status = readNodeAuthorityStatus();
    if (status.state !== "serving") {
      return;
    }
    deadlineTimer = setTimeout(
      () => {
        deadlineTimer = null;
        readNodeAuthorityStatus();
        if (!authorityFenced) {
          scheduleAuthorityDeadline();
        }
      },
      Math.min(
        MAX_NODE_AUTHORITY_TIMEOUT_MS,
        Math.max(
          0,
          status.window.selfFenceAtMonotonicMs -
            readNodeRuntimeMonotonicMilliseconds(options.clock),
        ),
      ),
    );
    deadlineTimer.unref();
  }

  function scheduleAuthorityTick() {
    if (options.clock.kind !== "system" || authorityFenced || authoritySchedulingClosed) {
      return;
    }
    if (authorityTimer) {
      clearTimeout(authorityTimer);
    }
    const status = readNodeAuthorityStatus();
    if (status.state !== "serving") {
      return;
    }
    authorityTimer = setTimeout(
      () => {
        authorityTimer = null;
        serviceNodeAuthority();
      },
      Math.min(
        MAX_NODE_AUTHORITY_TIMEOUT_MS,
        Math.max(
          0,
          status.nextActionAtMonotonicMs - readNodeRuntimeMonotonicMilliseconds(options.clock),
        ),
      ),
    );
    authorityTimer.unref();
  }

  function serviceNodeAuthority(): void {
    if (authoritySchedulingClosed) {
      return;
    }
    try {
      const previous = options.nodeAuthority.controller.readStatus();
      const current = options.nodeAuthority.controller.tick();
      if (current.state !== "serving") {
        retireNodeAuthority();
        return;
      }
      scheduleAuthorityDeadline();
      if (previous.state === "serving" && previous.window.renewalId !== current.window.renewalId) {
        for (const worker of workers.values()) {
          void worker.advanceNodeAuthorityWindow(current.window);
        }
      }
      readNodeAuthorityStatus();
    } finally {
      scheduleAuthorityTick();
    }
  }

  function startObjectWorker(binding: string, name: string) {
    const definition = options.objects[binding];
    const persistence = options.resolveObject(binding, name);
    const { port1, port2 } = new MessageChannel();
    const workerOptions: NodeObjectWorkerOptions = {
      port: port2,
      binding,
      name,
      moduleUrl: definition.moduleUrl,
      exportName: definition.exportName,
      clock: options.clock,
      persistence,
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./node-object-worker.js", import.meta.url), {
        workerData: workerOptions,
        transferList: [port2],
      });
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
    const session = createNodeMessagePortRpcSession<NodeObjectWorkerControl>(
      port1,
      undefined,
      () => {
        if (readNodeAuthorityStatus().state !== "serving") {
          throw new Error("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
        }
      },
    );
    worker.once("error", (error) => {
      session.abort(error);
    });
    const workerThreadId = worker.threadId;
    worker.once("exit", (code) => {
      releaseGraftControlStoreLock(workerThreadId);
      session.abort(new Error(`NODE_OBJECT_WORKER_EXITED:${binding}:${name}:${code}`));
    });
    let disconnected = false;
    session.remote.onRpcBroken(() => {
      disconnected = true;
    });
    const object = session.remote.getObject();
    let retirement: Promise<number> | null = null;
    let finalization: Promise<void> | null = null;
    let advancingNodeAuthority = false;
    let pendingNodeAuthorityWindow: GraftNodeAuthorityWindow | null = null;

    function retire() {
      session.abort(new Error("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED"));
      retirement ??= worker.terminate();
      void retirement.catch(() => {});
    }

    function finalizeWorker(reason: string): Promise<void> {
      finalization ??= (async () => {
        object[Symbol.dispose]();
        session.abort(new Error(reason));
        await (retirement ?? worker.terminate());
      })();
      return finalization;
    }

    function releaseWorkerAuthority(
      result: Awaited<ReturnType<NodeObjectWorkerControl["shutdown"]>>,
    ) {
      if (
        result.kind === "with-object-authority" &&
        readNodeAuthorityStatus().state === "serving"
      ) {
        options.nodeAuthority.releaseObject(result.authority);
      }
    }

    return {
      retire,
      object,
      control: session.remote,
      async advanceNodeAuthorityWindow(window: GraftNodeAuthorityWindow): Promise<void> {
        if (disconnected || retirement || finalization) {
          return;
        }
        // A stalled worker retains only the latest extension, never an unbounded RPC queue.
        pendingNodeAuthorityWindow = window;
        if (advancingNodeAuthority) {
          return;
        }
        advancingNodeAuthority = true;
        try {
          while (pendingNodeAuthorityWindow && !disconnected && !retirement && !finalization) {
            const nextWindow = pendingNodeAuthorityWindow;
            pendingNodeAuthorityWindow = null;
            await session.remote.advanceNodeAuthorityWindow(nextWindow);
          }
        } catch {
          // Worker-side validation rejects late extensions; only this activation is retired.
          retire();
        } finally {
          advancingNodeAuthority = false;
          pendingNodeAuthorityWindow = null;
        }
      },
      async cleanupIfIdle(idleSinceMonotonicMs: number) {
        if (disconnected || authorityFenced) {
          return { kind: "active" } as const;
        }
        const result = await session.remote.shutdownIfIdle(idleSinceMonotonicMs);
        if (result.kind === "active") {
          return { kind: "active" } as const;
        }
        let releaseFailure: unknown = null;
        try {
          releaseWorkerAuthority(result.result);
        } catch (error) {
          releaseFailure = error;
        } finally {
          await finalizeWorker("NODE_OBJECT_RUNTIME_OBJECT_EVICTED");
        }
        return { kind: "evicted", releaseFailure } as const;
      },
      async cleanup() {
        try {
          if (!disconnected && !authorityFenced) {
            releaseWorkerAuthority(await session.remote.shutdown());
          }
        } catch (error) {
          if (!disconnected) {
            throw error;
          }
        } finally {
          await finalizeWorker("NODE_OBJECT_RUNTIME_CLOSED");
        }
      },
    };
  }

  function getObjectWorker(binding: string, name: string) {
    requireOpen();
    const id = `${binding}:${name}`;
    const existing = workers.get(id);
    if (existing) {
      return existing;
    }
    const worker = startObjectWorker(binding, name);
    workers.set(id, worker);
    if (authorityFenced) {
      worker.retire();
    }
    requireOpen();
    return worker;
  }

  function configuredObjectIdleTimeoutMs(): number | null {
    return options.objectEviction.kind === "disabled" ? null : options.objectEviction.idleTimeoutMs;
  }

  async function evictIdleWorker(
    objectId: string,
    worker: ReturnType<typeof startObjectWorker>,
    idleSinceMonotonicMs: number,
  ): Promise<void> {
    const result = await worker.cleanupIfIdle(idleSinceMonotonicMs);
    if (result.kind === "active") {
      return;
    }
    if (workers.get(objectId) === worker) {
      workers.delete(objectId);
    }
    if (result.releaseFailure instanceof Error) {
      throw result.releaseFailure;
    }
    if (result.releaseFailure) {
      throw new Error("NODE_OBJECT_RUNTIME_IDLE_EVICTION_RELEASE_FAILED", {
        cause: result.releaseFailure,
      });
    }
  }

  function runObjectEvictionSweep(): Promise<void> {
    requireOpen();
    const idleTimeoutMs = configuredObjectIdleTimeoutMs();
    if (idleTimeoutMs === null) {
      return Promise.resolve();
    }
    objectEvictionSweep ??= (async () => {
      const idleSinceMonotonicMs = Math.max(
        0,
        readNodeRuntimeMonotonicMilliseconds(options.clock) - idleTimeoutMs,
      );
      const operations = [...workers].map(([objectId, worker]) => {
        const existing = idleEvictions.get(objectId);
        if (existing) {
          return existing;
        }
        const operation = evictIdleWorker(objectId, worker, idleSinceMonotonicMs).finally(() => {
          if (idleEvictions.get(objectId) === operation) {
            idleEvictions.delete(objectId);
          }
        });
        idleEvictions.set(objectId, operation);
        return operation;
      });
      const results = await Promise.allSettled(operations);
      throwObjectRuntimeFailures(results, "NODE_OBJECT_RUNTIME_IDLE_EVICTION_FAILED");
    })().finally(() => {
      objectEvictionSweep = null;
    });
    return objectEvictionSweep;
  }

  function scheduleObjectEvictionSweep(): void {
    const policy = options.objectEviction;
    if (closed || policy.kind !== "automatic") {
      return;
    }
    objectEvictionTimer = setTimeout(() => {
      objectEvictionTimer = null;
      // Authority fencing can throw before the sweep returns its Promise.
      void Promise.resolve()
        .then(runObjectEvictionSweep)
        .catch((error: unknown) => {
          policy.reportError(error);
        })
        .finally(() => {
          scheduleObjectEvictionSweep();
        });
    }, policy.sweepIntervalMs);
    objectEvictionTimer.unref();
  }

  function createRuntimeOutputScope() {
    const outputScopeId = randomUUID();
    const scopedObjects = new Map<
      ReturnType<typeof startObjectWorker>,
      ReturnType<ReturnType<typeof startObjectWorker>["control"]["getObjectForOutputScope"]>
    >();
    const namespaceHandles = new Set<Disposable>();
    let released = false;

    return {
      ownNamespaceHandle<THandle extends Disposable>(handle: THandle): THandle {
        if (released) {
          handle[Symbol.dispose]();
          throw new Error("NODE_RUNTIME_OUTPUT_SCOPE_CLOSED");
        }
        namespaceHandles.add(handle);
        return handle;
      },
      getObject(worker: ReturnType<typeof startObjectWorker>) {
        if (released) {
          throw new Error("NODE_RUNTIME_OUTPUT_SCOPE_CLOSED");
        }
        let object = scopedObjects.get(worker);
        if (!object) {
          object = worker.control.getObjectForOutputScope(outputScopeId);
          scopedObjects.set(worker, object);
        }
        return object.dup();
      },
      async release() {
        if (released) {
          throw new Error("NODE_RUNTIME_OUTPUT_SCOPE_CLOSED");
        }
        released = true;
        const failures: unknown[] = [];
        for (const handle of namespaceHandles) {
          try {
            handle[Symbol.dispose]();
          } catch (error) {
            failures.push(error);
          }
        }
        namespaceHandles.clear();
        const results = await Promise.allSettled(
          [...scopedObjects].map(async ([worker, object]) => {
            try {
              await worker.control.releaseOutputScope(outputScopeId);
            } finally {
              object[Symbol.dispose]();
            }
          }),
        );
        failures.push(
          ...results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          ),
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "NODE_RUNTIME_OUTPUT_GATE_FAILED");
        }
      },
    };
  }

  async function getPreparedObjectWorker(binding: string, name: string) {
    const id = `${binding}:${name}`;
    while (true) {
      const idleEviction = idleEvictions.get(id);
      if (idleEviction) {
        await idleEviction;
        continue;
      }
      const worker = getObjectWorker(binding, name);
      try {
        await worker.control.prepareForEvent();
        return worker;
      } catch (error) {
        if (workers.get(id) === worker) {
          workers.delete(id);
        }
        worker.retire();
        throw error;
      }
    }
  }

  async function getPreparedLocalObject(
    binding: string,
    name: string,
    outputScope: ReturnType<typeof createRuntimeOutputScope> | null,
  ): Promise<RpcTarget> {
    const worker = await getPreparedObjectWorker(binding, name);
    return (outputScope?.getObject(worker) ?? worker.object.dup()) as RpcTarget;
  }

  async function serviceObjectAlarmWork(
    work: GraftObjectAlarmWork,
    nowEpochMs: number,
  ): Promise<void> {
    const separator = work.objectId.indexOf(":");
    const binding = work.objectId.slice(0, separator);
    const name = work.objectId.slice(separator + 1);
    if (separator <= 0 || name.length === 0 || !Object.hasOwn(options.objects, binding)) {
      throw new Error(`NODE_OBJECT_RUNTIME_UNKNOWN_ALARM_OBJECT:${work.objectId}`);
    }
    let worker: ReturnType<typeof startObjectWorker>;
    try {
      worker = await getPreparedObjectWorker(binding, name);
    } catch (error) {
      if (isPreDeliveryObjectClaimRace(error)) {
        return;
      }
      throw error;
    }
    if (work.kind === "reconcile") {
      await worker.control.reconcileAlarmWork(work.reconciliationId);
      return;
    }
    await worker.control.deliverAlarm(
      { timestamp: work.dueAtMs, installationId: work.installationId },
      nowEpochMs,
    );
  }

  async function resolveRoutedObject(
    binding: string,
    name: string,
    outputScope: ReturnType<typeof createRuntimeOutputScope> | null,
  ): Promise<RpcTarget> {
    const objectId = `${binding}:${name}`;
    let provisioningAttempted = false;
    let routeAttempt = 0;
    while (routeAttempt < 3) {
      requireOpen();
      const routingState = options.peerRouting.readObjectRoutingState(objectId);
      if (!routingState) {
        if (provisioningAttempted) {
          throw new Error(`NODE_OBJECT_RUNTIME_OBJECT_PROVISIONING_NOT_VISIBLE:${objectId}`);
        }
        provisioningAttempted = true;
        options.peerRouting.ensureObjectProvisioned(objectId);
        continue;
      }
      routeAttempt += 1;
      if (shouldAttemptLocalObjectActivation(routingState, options.peerRouting, options.clock)) {
        try {
          return await getPreparedLocalObject(binding, name, outputScope);
        } catch (error) {
          if (routeAttempt < 3 && isPreDeliveryObjectClaimRace(error)) {
            continue;
          }
          throw error;
        }
      }
      if (routingState.kind !== "owned-with-node-lease") {
        throw new Error(`NODE_OBJECT_RUNTIME_ROUTE_STATE_INVALID:${objectId}`);
      }
      const route = createNodePeerObjectRoute(binding, name, routingState);
      try {
        return await options.peerRouting.getRemoteObject(route);
      } catch (error) {
        if (routeAttempt < 3 && isPreDeliveryPeerRouteRefusal(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(`NODE_OBJECT_RUNTIME_ROUTE_ATTEMPTS_EXHAUSTED:${objectId}`);
  }

  async function getLocalObjectForPeer(
    route: NodePeerObjectRoute,
    assertPeerAuthority: () => void,
  ): Promise<RpcTarget> {
    requireOpen();
    assertPeerAuthority();
    const routingState = options.peerRouting.readObjectRoutingState(route.objectId);
    requireExpectedLocalPeerRoute(routingState, route, options.peerRouting.identity, options.clock);
    const object = await getPreparedLocalObject(route.binding, route.name, null);
    assertPeerAuthority();
    return createNodePeerForwardingTarget(
      () => Promise.resolve(object),
      () => {
        requireOpen();
        assertPeerAuthority();
      },
    );
  }

  async function runWorkerStage(
    operation: (control: RpcStub<NodeObjectWorkerControl>) => Promise<void>,
    message: string,
  ) {
    requireOpen();
    const results = await Promise.allSettled(
      [...workers.values()].map(async ({ control }) => {
        await operation(control);
      }),
    );
    throwObjectRuntimeFailures(results, message);
  }

  const objects = Object.fromEntries(
    Object.keys(options.objects).map((binding) => [
      binding,
      {
        get(name: string) {
          requireOpen();
          const outputScope = activeOutputScope.getStore() ?? null;
          const object = new RpcStub(
            createNodePeerForwardingTarget(
              () => resolveRoutedObject(binding, name, outputScope),
              requireOpen,
            ),
          ) as unknown as NodeRuntimeObjectStub<TBindings[keyof TBindings]> & Disposable;
          return outputScope?.ownNamespaceHandle(object) ?? object;
        },
      },
    ]),
  ) as unknown as NodeRuntimeObjects<TBindings>;

  const runtime = {
    objects,
    /** Holds external output until touched state is durable and disposes namespace handles on release. */
    async runWithOutputGate<TResult>(
      operation: () => TResult | Promise<TResult>,
    ): Promise<TResult> {
      requireOpen();
      if (activeOutputScope.getStore()) {
        return await operation();
      }
      const outputScope = createRuntimeOutputScope();
      let outcome: { kind: "success"; value: TResult } | { kind: "failure"; error: unknown };
      try {
        outcome = {
          kind: "success",
          value: await activeOutputScope.run(outputScope, operation),
        };
      } catch (error) {
        outcome = { kind: "failure", error };
      }
      await outputScope.release();
      requireOpen();
      if (outcome.kind === "failure") {
        throw outcome.error;
      }
      return outcome.value;
    },
    async drainAlarms() {
      requireOpen();
      const nowEpochMs = readNodeRuntimeEpochMilliseconds(options.clock);
      const work = options.readServiceableAlarmWork(nowEpochMs);
      const results = await Promise.allSettled(
        work.map(async (entry) => {
          await serviceObjectAlarmWork(entry, nowEpochMs);
        }),
      );
      throwObjectRuntimeFailures(results, "NODE_OBJECT_RUNTIME_ALARM_DELIVERY_FAILED");
    },
    async drainWaitUntil() {
      await runWorkerStage(async (control) => {
        await control.drainWaitUntil();
      }, "NODE_OBJECT_RUNTIME_WAIT_UNTIL_FAILED");
    },
    async tick() {
      requireOpen();
      serviceNodeAuthority();
      requireOpen();
      await runtime.drainAlarms();
    },
    /** Evicts resident workers idle for the configured duration without deleting durable state. */
    async sweepIdleObjects() {
      await runObjectEvictionSweep();
    },
    /** Requires settled application RPC and streams; drains registered waitUntil work, not capability calls. */
    cleanup(): Promise<void> {
      cleanup ??= (async () => {
        closed = true;
        if (objectEvictionTimer) {
          clearTimeout(objectEvictionTimer);
          objectEvictionTimer = null;
        }
        readNodeAuthorityStatus();
        try {
          const failures: unknown[] = [];
          try {
            await objectEvictionSweep;
          } catch (error) {
            failures.push(error);
          }
          const results = await Promise.allSettled(
            [...workers.values()].map(async (worker) => {
              await worker.cleanup();
            }),
          );
          failures.push(
            ...results.flatMap((result) =>
              result.status === "rejected" ? [result.reason as unknown] : [],
            ),
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "NODE_OBJECT_RUNTIME_CLEANUP_FAILED");
          }
        } finally {
          authoritySchedulingClosed = true;
          if (authorityTimer) {
            clearTimeout(authorityTimer);
            authorityTimer = null;
          }
          if (deadlineTimer) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }
          options.nodeAuthority.controller.close();
        }
      })();
      return cleanup;
    },
  };
  scheduleAuthorityDeadline();
  scheduleAuthorityTick();
  scheduleObjectEvictionSweep();
  return { runtime, readNodeAuthorityStatus, getLocalObjectForPeer };
}

function resolveGraftObjectLocation(options: {
  objectId: string;
  storage: GraftNodeRuntimeStorage;
  controlStore: GraftControlStore;
  clock: NodeRuntimeClock;
  policy: GraftObjectProvisioningPolicy;
  databaseOperations: GraftDatabaseOperations;
}): GraftObjectLocation {
  if (options.policy.kind === "lazy") {
    return provisionGraftObject({
      objectId: options.objectId,
      storage: options.storage,
      controlStore: options.controlStore,
      clock: options.clock,
      databaseOperations: options.databaseOperations,
    }).location;
  }
  const existing = options.controlStore.readObjectLocation(options.objectId);
  if (!existing) {
    throw new Error(`NODE_OBJECT_RUNTIME_OBJECT_NOT_PROVISIONED:${options.objectId}`);
  }
  return existing;
}

function validateGraftObjectProvisioningPolicy(policy: GraftObjectProvisioningPolicy): void {
  if (policy?.kind !== "lazy" && policy?.kind !== "preprovisioned") {
    throw new Error("NODE_OBJECT_RUNTIME_PROVISIONING_POLICY_INVALID");
  }
}

function validateNodeObjectActivationEvictionPolicy(
  policy: NodeObjectActivationEvictionPolicy,
): void {
  if (policy?.kind === "disabled") {
    return;
  }
  if (
    (policy?.kind !== "manual" && policy?.kind !== "automatic") ||
    !Number.isSafeInteger(policy.idleTimeoutMs) ||
    policy.idleTimeoutMs <= 0 ||
    (policy.kind === "automatic" &&
      (!Number.isSafeInteger(policy.sweepIntervalMs) || policy.sweepIntervalMs <= 0))
  ) {
    throw new Error("NODE_OBJECT_RUNTIME_EVICTION_POLICY_INVALID");
  }
}

function validateNodeRuntimeObjectBindings(objects: NodeRuntimeObjectBindings): void {
  for (const [binding, definition] of Object.entries(objects)) {
    if (binding.length === 0 || binding.includes(":")) {
      throw new Error(`NODE_OBJECT_RUNTIME_INVALID_BINDING:${binding}`);
    }
    if (new URL(definition.moduleUrl).protocol !== "file:" || definition.exportName.length === 0) {
      throw new Error(`NODE_OBJECT_RUNTIME_INVALID_MODULE:${binding}`);
    }
  }
}
