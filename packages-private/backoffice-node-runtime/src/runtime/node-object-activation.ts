import { RpcTarget } from "capnweb";

import { GraftControlStore } from "../graft/graft-control-store";
import type {
  GraftDatabaseOperations,
  GraftDatabaseOperationsFactory,
  ImportableGraftDatabaseOperations,
} from "../graft/graft-database-operations";
import { GraftDurableObjectState } from "../graft/graft-durable-object-state";
import type { GraftNodeAuthorityWindow } from "../graft/graft-node-authority";
import { prepareGraftObjectActivation } from "../graft/graft-object-activation";
import { GraftObjectAlarmCoordinator } from "../graft/graft-object-alarm-coordinator";
import type { GraftObjectAuthority } from "../graft/graft-object-authority";
import type { GraftNodeRuntimeStorage } from "../graft/graft-runtime-storage";
import { manageAuthorityBoundGraftObjectDatabase } from "../sqlite/managed-node-runtime-object-database";
import {
  currentNodeObjectOutputBoundary,
  runWithNodeObjectOutputBoundary,
  type NodeObjectOutputBoundary,
} from "./node-object-output-boundary";
import {
  readNodeRuntimeEpochMilliseconds,
  readNodeRuntimeMonotonicMilliseconds,
  type NodeRuntimeClock,
} from "./node-runtime-clock";
import type { NodeRuntimeObjectFactory } from "./node-runtime-object";

/** Identifies the sole object and fenced Graft database admitted into an object worker. */
export type NodeObjectActivationOptions = {
  binding: string;
  name: string;
  moduleUrl: string;
  exportName: string;
  clock: NodeRuntimeClock;
  persistence: {
    remoteLogId: string;
    operations: ImportableGraftDatabaseOperations;
    storage: GraftNodeRuntimeStorage;
    nodeAuthority: GraftNodeAuthorityWindow;
    maximumClockSkewMs: number;
    maxFenceAttempts: number;
  };
};

/** Identifies one exact alarm installation selected by the durable fleet alarm index. */
export type NodeObjectAlarmDelivery = {
  timestamp: number;
  installationId: string;
};

/** Reports process-local activity used to decide whether a resident object can be evicted. */
export type NodeObjectActivationActivity = {
  activeEventCount: number;
  openOutputScopeCount: number;
  hasPendingWork: boolean;
  lastCompletedActivityAtMonotonicMs: number;
};

/** Graceful shutdown returns only the exact claim that can be conditionally released. */
export type NodeObjectActivationShutdownResult = {
  kind: "with-object-authority";
  authority: GraftObjectAuthority;
};

/** Idle shutdown either preserves an active object or returns its conditionally releasable claim. */
export type NodeObjectActivationIdleShutdownResult =
  | { kind: "active"; activity: NodeObjectActivationActivity }
  | { kind: "shutdown"; result: NodeObjectActivationShutdownResult };

/** One initialized object owns all handler, capability, alarm, and shutdown activity in its worker. */
export type NodeObjectActivation = Awaited<ReturnType<typeof createNodeObjectActivation>>;

/** Initializes one fenced object; events may interleave, but shutdown waits for all admitted work. */
export async function createNodeObjectActivation(options: NodeObjectActivationOptions) {
  const module = (await import(options.moduleUrl)) as Record<string, unknown>;
  const exportedFactory = module[options.exportName];
  if (typeof exportedFactory !== "function") {
    throw new Error(
      `NODE_OBJECT_WORKER_FACTORY_MISSING:${options.moduleUrl}:${options.exportName}`,
    );
  }
  const createObject = exportedFactory as NodeRuntimeObjectFactory;
  const id = new NodeObjectId(options.binding, options.name) as unknown as DurableObjectId;
  const activity = new NodeObjectActivity(options.clock);
  const objectOperations = await loadGraftDatabaseOperations(options.persistence.operations);
  const preparedActivation = prepareGraftObjectActivation({
    storage: options.persistence.storage,
    objectId: String(id),
    remoteLogId: options.persistence.remoteLogId,
    nodeAuthority: options.persistence.nodeAuthority,
    maximumClockSkewMs: options.persistence.maximumClockSkewMs,
    clock: options.clock,
    objectOperations,
    maxFenceAttempts: options.persistence.maxFenceAttempts,
  });
  const objectDatabase = manageAuthorityBoundGraftObjectDatabase(
    preparedActivation.database,
    objectOperations,
    preparedActivation.authority,
    options.clock,
  );
  let alarmCoordinator: GraftObjectAlarmCoordinator | null = null;
  try {
    const objectAlarmCoordinator = new GraftObjectAlarmCoordinator({
      database: objectDatabase,
      controlStore: new GraftControlStore(options.persistence.storage),
      authority: preparedActivation.authority,
      clock: options.clock,
    });
    alarmCoordinator = objectAlarmCoordinator;
    const state = new GraftDurableObjectState(id, objectDatabase, objectAlarmCoordinator);
    const object = createObject({
      id,
      name: options.name,
      state,
      nowEpochMs: () => readNodeRuntimeEpochMilliseconds(options.clock),
    });
    const objectProperties = object as unknown as Record<PropertyKey, unknown>;
    state.setPendingWorkSettledListener(() => {
      activity.recordCompletedActivity();
    });
    const outputScopes = new Map<string, { boundary: NodeObjectOutputScope; target: RpcTarget }>();

    function createObjectTarget(outputBoundary: NodeObjectOutputScope | null): RpcTarget {
      // Only handlers cross the RPC boundary; ordinary classes retain their original `this`.
      return new Proxy(new RpcTarget(), {
        get(target, property): unknown {
          const targetProperties = target as unknown as Record<PropertyKey, unknown>;
          if (typeof property !== "string" || property === "constructor") {
            return targetProperties[property];
          }
          if (property === "then" || property === "alarm") {
            return undefined;
          }
          const method = objectProperties[property];
          if (typeof method !== "function") {
            return undefined;
          }
          const invoke = async (...args: unknown[]) =>
            await activity.run(
              async () =>
                await state.runEvent(async () => {
                  const result = await (method as (...args: unknown[]) => unknown).apply(
                    object,
                    args,
                  );
                  return gateReturnedRpcCapability(
                    result,
                    state,
                    currentNodeObjectOutputBoundary(),
                    activity,
                  );
                }),
            );
          if (!outputBoundary) {
            return invoke;
          }
          return (...args: unknown[]) =>
            runWithNodeObjectOutputBoundary(outputBoundary, () => invoke(...args));
        },
      });
    }

    const target = createObjectTarget(null);
    // Initialization is its own durability boundary, before any caller can open an output scope.
    await state.runEvent(() => {});
    await objectAlarmCoordinator.synchronizeAlarmWork();
    preparedActivation.markReady();
    activity.recordCompletedActivity();
    let shutdownOperation: Promise<NodeObjectActivationShutdownResult> | null = null;

    async function drainPendingWork(): Promise<void> {
      while (state.hasPendingWork) {
        await state.runEvent(async () => await state.drainWaitUntil());
      }
    }

    function shutdownObject(): Promise<NodeObjectActivationShutdownResult> {
      shutdownOperation ??= (async () => {
        try {
          await activity.waitForIdle();
          await drainPendingWork();
          objectDatabase.ensureDurableStoragePosition(objectDatabase.committedStoragePosition);
          const authority = preparedActivation.authority;
          return {
            kind: "with-object-authority",
            authority: {
              objectId: authority.objectId,
              epoch: authority.epoch,
              ownerNodeId: authority.ownerNodeId,
              processGeneration: authority.processGeneration,
              claimId: authority.claimId,
            },
          };
        } finally {
          objectAlarmCoordinator.close();
          objectDatabase.close();
        }
      })();
      return shutdownOperation;
    }

    return {
      target,
      getObjectForOutputScope(outputScopeId: string) {
        activity.assertAccepting();
        if (outputScopeId.length === 0) {
          throw new Error("NODE_OBJECT_OUTPUT_SCOPE_ID_MISSING");
        }
        const existing = outputScopes.get(outputScopeId);
        if (existing) {
          return existing.target;
        }
        const boundary = new NodeObjectOutputScope();
        const scopedTarget = createObjectTarget(boundary);
        outputScopes.set(outputScopeId, { boundary, target: scopedTarget });
        return scopedTarget;
      },
      releaseOutputScope(outputScopeId: string) {
        const outputScope = outputScopes.get(outputScopeId);
        if (!outputScope) {
          throw new Error(`NODE_OBJECT_OUTPUT_SCOPE_MISSING:${outputScopeId}`);
        }
        outputScopes.delete(outputScopeId);
        outputScope.boundary.release(state);
        activity.recordCompletedActivity();
      },
      advanceNodeAuthorityWindow(window: GraftNodeAuthorityWindow) {
        objectDatabase.advanceNodeAuthorityWindow(window);
      },
      async prepareForEvent() {
        await activity.runMaintenance(async () => {
          await state.prepareForEvent();
        });
      },
      async reconcileAlarmWork(reconciliationId: string) {
        await activity.runMaintenance(async () => {
          await objectAlarmCoordinator.reconcileAlarmWork(reconciliationId);
        });
      },
      async deliverAlarm(expectedAlarm: NodeObjectAlarmDelivery, nowEpochMs: number) {
        activity.assertAccepting();
        const alarm = state.dueAlarm(nowEpochMs);
        if (alarm?.installationId === expectedAlarm.installationId) {
          await activity.run(async () => {
            await state.runEvent(async () => {
              await state.deliverAlarm(alarm, nowEpochMs, async () => {
                const handler = objectProperties["alarm"];
                if (typeof handler === "function") {
                  await (handler as () => unknown).call(object);
                }
              });
            });
          });
        }
      },
      async drainWaitUntil() {
        await activity.runMaintenance(drainPendingWork);
      },
      readActivationActivity() {
        return activity.read(outputScopes.size, state.hasPendingWork);
      },
      async shutdownIfIdle(
        idleSinceMonotonicMs: number,
      ): Promise<NodeObjectActivationIdleShutdownResult> {
        const currentActivity = activity.read(outputScopes.size, state.hasPendingWork);
        if (!activity.beginIdleShutdown(currentActivity, idleSinceMonotonicMs)) {
          return { kind: "active", activity: currentActivity };
        }
        return { kind: "shutdown", result: await shutdownObject() };
      },
      shutdown(): Promise<NodeObjectActivationShutdownResult> {
        activity.beginShutdown();
        return shutdownObject();
      },
    };
  } catch (error) {
    preparedActivation.abort();
    alarmCoordinator?.close();
    objectDatabase.close();
    throw error;
  }
}

class NodeObjectId {
  readonly namespace: string;
  readonly name: string;

  constructor(namespace: string, name: string) {
    this.namespace = namespace;
    this.name = name;
  }

  toString() {
    return `${this.namespace}:${this.name}`;
  }

  equals(other: unknown) {
    return other instanceof NodeObjectId && other.toString() === this.toString();
  }
}

class NodeObjectActivity {
  readonly #clock: NodeRuntimeClock;
  readonly #idleWaiters = new Set<() => void>();
  #activeEventCount = 0;
  #acceptingEvents = true;
  #lastCompletedActivityAtMonotonicMs: number;

  constructor(clock: NodeRuntimeClock) {
    this.#clock = clock;
    this.#lastCompletedActivityAtMonotonicMs = readNodeRuntimeMonotonicMilliseconds(clock);
  }

  assertAccepting(): void {
    if (!this.#acceptingEvents) {
      throw new Error("NODE_OBJECT_ACTIVATION_EVICTING");
    }
  }

  async run<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    return await this.runMaintenance(async () => {
      try {
        return await operation();
      } finally {
        this.recordCompletedActivity();
      }
    });
  }

  // Maintenance must exclude concurrent eviction without extending the application's idle deadline.
  async runMaintenance<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    this.assertAccepting();
    this.#activeEventCount += 1;
    try {
      return await operation();
    } finally {
      this.#activeEventCount -= 1;
      if (this.#activeEventCount === 0) {
        for (const resolve of this.#idleWaiters) {
          resolve();
        }
        this.#idleWaiters.clear();
      }
    }
  }

  recordCompletedActivity(): void {
    this.#lastCompletedActivityAtMonotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
  }

  read(openOutputScopeCount: number, hasPendingWork: boolean): NodeObjectActivationActivity {
    return {
      activeEventCount: this.#activeEventCount,
      openOutputScopeCount,
      hasPendingWork,
      lastCompletedActivityAtMonotonicMs: this.#lastCompletedActivityAtMonotonicMs,
    };
  }

  beginIdleShutdown(activity: NodeObjectActivationActivity, idleSinceMonotonicMs: number): boolean {
    if (
      !this.#acceptingEvents ||
      activity.activeEventCount > 0 ||
      activity.openOutputScopeCount > 0 ||
      activity.hasPendingWork ||
      activity.lastCompletedActivityAtMonotonicMs > idleSinceMonotonicMs
    ) {
      return false;
    }
    this.#acceptingEvents = false;
    return true;
  }

  beginShutdown(): void {
    this.#acceptingEvents = false;
  }

  async waitForIdle(): Promise<void> {
    if (this.#activeEventCount === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }
}

class NodeObjectOutputScope implements NodeObjectOutputBoundary {
  #requiredPosition = 0;
  #open = true;

  assertOpen(): void {
    if (!this.#open) {
      throw new Error("NODE_OBJECT_OUTPUT_SCOPE_CLOSED");
    }
  }

  observeStoragePosition(position: number): void {
    this.assertOpen();
    this.#requiredPosition = Math.max(this.#requiredPosition, position);
  }

  release(state: GraftDurableObjectState): void {
    this.assertOpen();
    this.#open = false;
    state.ensureOutputDurable(this.#requiredPosition);
  }
}

function gateReturnedRpcCapability(
  value: unknown,
  state: GraftDurableObjectState,
  outputBoundary: NodeObjectOutputBoundary | null,
  activity: NodeObjectActivity,
): unknown {
  if (!(value instanceof RpcTarget)) {
    return value;
  }
  const capability = value as unknown as Record<PropertyKey, unknown>;
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(new RpcTarget(), {
    get(target, property): unknown {
      const targetProperties = target as unknown as Record<PropertyKey, unknown>;
      if (typeof property !== "string" || property === "constructor") {
        return targetProperties[property];
      }
      if (property === "then") {
        return undefined;
      }
      if (cache.has(property)) {
        return cache.get(property);
      }
      const method = capability[property];
      if (typeof method !== "function") {
        return undefined;
      }
      const wrapped = async (...args: unknown[]) => {
        const invoke = async () =>
          await activity.run(
            async () =>
              await state.runEvent(async () => {
                const result = await (method as (...innerArgs: unknown[]) => unknown).apply(
                  value,
                  args,
                );
                return gateReturnedRpcCapability(result, state, outputBoundary, activity);
              }),
          );
        return outputBoundary
          ? await runWithNodeObjectOutputBoundary(outputBoundary, invoke)
          : await invoke();
      };
      cache.set(property, wrapped);
      return wrapped;
    },
  });
}

async function loadGraftDatabaseOperations(
  definition: ImportableGraftDatabaseOperations,
): Promise<GraftDatabaseOperations> {
  const module = (await import(definition.moduleUrl)) as Record<string, unknown>;
  const exportedFactory = module[definition.exportName];
  if (typeof exportedFactory !== "function") {
    throw new Error(
      `GRAFT_DATABASE_OPERATIONS_FACTORY_MISSING:${definition.moduleUrl}:${definition.exportName}`,
    );
  }
  const createOperations = exportedFactory as GraftDatabaseOperationsFactory;
  return createOperations(definition.input);
}
