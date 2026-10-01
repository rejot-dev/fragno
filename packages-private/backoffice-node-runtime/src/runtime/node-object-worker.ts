import { workerData, type MessagePort } from "node:worker_threads";

import { RpcTarget } from "capnweb";

import type {
  GraftDatabaseOperations,
  GraftDatabaseOperationsFactory,
  ImportableGraftDatabaseOperations,
} from "../graft/graft-database-operations";
import { GraftDurableObjectState } from "../graft/graft-durable-object-state";
import { createNodeMessagePortRpcSession } from "../rpc/node-message-port-rpc";
import {
  openGraftNodeRuntimeObjectDatabase,
  openLocalNodeRuntimeObjectDatabase,
} from "../sqlite/managed-node-runtime-object-database";
import { SqliteDurableObjectState } from "../sqlite/sqlite-durable-object-state";
import { SqliteObjectCoordination } from "../sqlite/sqlite-object-coordination";
import { SqliteBackofficeObjectStorage } from "../sqlite/sqlite-object-storage";
import {
  LocalDurableObjectNamespace,
  ProcessLocalObjectExecutionCoordinator,
  type BackofficeDurableObjectState,
} from "./local-durable-objects";
import {
  runWithNodeObjectOutputBoundary,
  type NodeObjectOutputBoundary,
} from "./node-object-output-boundary";
import { readNodeRuntimeClock, type NodeRuntimeClock } from "./node-runtime-clock";
import type { NodeRuntimeObjectFactory } from "./node-runtime-object";

type NodeObjectWorkerPersistence =
  | { kind: "local"; directory: string }
  | {
      kind: "graft";
      localTag: string;
      remoteLogId: string;
      operations: ImportableGraftDatabaseOperations;
    };

/** Bootstrap data carries module identity, persistence, and shared clock state, never application RPC values. */
export type NodeObjectWorkerOptions = {
  port: MessagePort;
  binding: string;
  name: string;
  moduleUrl: string;
  exportName: string;
  clock: NodeRuntimeClock;
  persistence: NodeObjectWorkerPersistence;
};

/** Private control RPC shares the worker and object instance used by public fetch and RPC calls. */
export type NodeObjectWorkerControl = {
  getObject(): Promise<RpcTarget>;
  getObjectForOutputScope(outputScopeId: string): Promise<RpcTarget>;
  releaseOutputScope(outputScopeId: string): Promise<void>;
  prepareForEvent(): Promise<void>;
  deliverDueAlarm(nowEpochMs: number): Promise<void>;
  drainWaitUntil(): Promise<void>;
  shutdown(): Promise<void>;
};

class WorkerNodeObjectOutputScope implements NodeObjectOutputBoundary {
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

  release(state: BackofficeDurableObjectState): void {
    this.assertOpen();
    this.#open = false;
    state.ensureOutputDurable(this.#requiredPosition);
  }
}

async function createWorkerObject(options: NodeObjectWorkerOptions) {
  const module = (await import(options.moduleUrl)) as Record<string, unknown>;
  const exportedFactory = module[options.exportName];
  if (typeof exportedFactory !== "function") {
    throw new Error(
      `NODE_OBJECT_WORKER_FACTORY_MISSING:${options.moduleUrl}:${options.exportName}`,
    );
  }
  const createObject = exportedFactory as NodeRuntimeObjectFactory;
  const objectId = `${options.binding}:${options.name}`;
  const objectDatabase =
    options.persistence.kind === "graft"
      ? openGraftNodeRuntimeObjectDatabase(
          options.persistence.localTag,
          options.persistence.remoteLogId,
          await loadGraftDatabaseOperations(options.persistence.operations),
        )
      : openLocalNodeRuntimeObjectDatabase(options.persistence.directory, objectId);
  let storage: SqliteBackofficeObjectStorage | null = null;
  let coordination: SqliteObjectCoordination | null = null;
  const executionCoordinator = new ProcessLocalObjectExecutionCoordinator();
  try {
    let createState: (id: DurableObjectId) => BackofficeDurableObjectState;
    if (options.persistence.kind === "graft") {
      const identity = objectDatabase.read(
        (database) =>
          database.get(
            "SELECT object_id FROM node_runtime_object_identity WHERE singleton = 1",
            [],
          ) as { object_id: string } | null,
      );
      if (identity?.object_id !== objectId) {
        throw new Error(`GRAFT_OBJECT_IDENTITY_MISMATCH:${objectId}`);
      }
      createState = (id) => new GraftDurableObjectState(id, objectDatabase);
    } else {
      storage = new SqliteBackofficeObjectStorage(options.persistence.directory);
      coordination = new SqliteObjectCoordination(storage);
      createState = (id) =>
        new SqliteDurableObjectState(id, objectDatabase, storage!, coordination!);
    }

    const namespace = new LocalDurableObjectNamespace({
      name: options.binding,
      executionCoordinator,
      createState,
      createObject: (input) =>
        createObject({
          ...input,
          name: options.name,
          nowEpochMs: () => readNodeRuntimeClock(options.clock),
        }),
    });
    const id = namespace.idFromName(options.name);
    const object = namespace.get(id);
    const objectProperties = object as unknown as Record<PropertyKey, unknown>;
    const [instance] = namespace.instances();
    const outputScopes = new Map<
      string,
      { boundary: WorkerNodeObjectOutputScope; target: RpcTarget }
    >();

    function createObjectTarget(outputBoundary: WorkerNodeObjectOutputScope | null): RpcTarget {
      // The capability exposes handlers, not state, lifecycle operations, or arbitrary fields.
      // A RpcTarget adapter also supports factories returning ordinary object literals or classes.
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
          const invokeMethod = method as (...args: unknown[]) => unknown;
          if (!outputBoundary) {
            return (...args: unknown[]): unknown => invokeMethod.apply(object, args);
          }
          return (...args: unknown[]): unknown =>
            runWithNodeObjectOutputBoundary(outputBoundary, () => invokeMethod.apply(object, args));
        },
      });
    }

    const target = createObjectTarget(null);
    await namespace.restorePersisted(id);
    return {
      target,
      getObjectForOutputScope(outputScopeId: string) {
        if (outputScopeId.length === 0) {
          throw new Error("NODE_OBJECT_OUTPUT_SCOPE_ID_MISSING");
        }
        const existing = outputScopes.get(outputScopeId);
        if (existing) {
          return existing.target;
        }
        const boundary = new WorkerNodeObjectOutputScope();
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
        outputScope.boundary.release(instance.state);
      },
      async prepareForEvent() {
        await instance.state.runEvent(() => {});
      },
      async deliverDueAlarm(nowEpochMs: number) {
        const alarm = instance.state.dueAlarm(nowEpochMs);
        if (alarm) {
          await namespace.deliverAlarm(instance, alarm, nowEpochMs);
        }
      },
      async drainWaitUntil() {
        while (instance.state.hasPendingWork) {
          await namespace.drainWaitUntil();
        }
      },
      async shutdown() {
        try {
          await executionCoordinator.waitForIdle();
          while (instance.state.hasPendingWork) {
            await namespace.drainWaitUntil();
          }
        } finally {
          await coordination?.waitForIdle();
          storage?.close();
          objectDatabase.close();
        }
      },
    };
  } catch (error) {
    await coordination?.waitForIdle();
    storage?.close();
    objectDatabase.close();
    throw error;
  }
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

class NodeObjectWorkerApi extends RpcTarget implements NodeObjectWorkerControl {
  readonly #ready: Promise<Awaited<ReturnType<typeof createWorkerObject>>>;

  constructor(ready: Promise<Awaited<ReturnType<typeof createWorkerObject>>>) {
    super();
    this.#ready = ready;
  }

  async getObject() {
    return (await this.#ready).target;
  }

  async getObjectForOutputScope(outputScopeId: string) {
    return (await this.#ready).getObjectForOutputScope(outputScopeId);
  }

  async releaseOutputScope(outputScopeId: string) {
    (await this.#ready).releaseOutputScope(outputScopeId);
  }

  async prepareForEvent() {
    await (await this.#ready).prepareForEvent();
  }

  async deliverDueAlarm(nowEpochMs: number) {
    await (await this.#ready).deliverDueAlarm(nowEpochMs);
  }

  async drainWaitUntil() {
    await (await this.#ready).drainWaitUntil();
  }

  async shutdown() {
    // A failed factory has already closed its storage; shutdown must not mask the original error.
    const object = await this.#ready.catch(() => null);
    await object?.shutdown();
  }
}

const options = workerData as NodeObjectWorkerOptions;
const ready = createWorkerObject(options);
void ready.catch(() => {});
createNodeMessagePortRpcSession(options.port, new NodeObjectWorkerApi(ready));
