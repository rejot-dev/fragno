import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";

import type { RpcStub } from "capnweb";

import { GraftControlStore, type GraftNodeLease } from "../graft/graft-control-store";
import {
  defineGraftDatabaseOperations,
  type ImportableGraftDatabaseOperations,
} from "../graft/graft-database-operations";
import { DEFAULT_GRAFT_OBJECT_ACTIVATION_FENCE_ATTEMPTS } from "../graft/graft-object-activation";
import {
  GraftObjectDirectory,
  type GraftNodeRuntimeStorage,
} from "../graft/graft-object-directory";
import { createNodeMessagePortRpcSession } from "../rpc/node-message-port-rpc";
import { runNodeBackofficeAlarmTick } from "../scheduling/node-alarm-scheduler";
import { SqliteBackofficeObjectStorage } from "../sqlite/sqlite-object-storage";
import type { NodeObjectWorkerControl, NodeObjectWorkerOptions } from "./node-object-worker";
import { readNodeRuntimeClock, type NodeRuntimeClock } from "./node-runtime-clock";
import type { NodeRuntimeObjectBindings, NodeRuntimeObjectStub } from "./node-runtime-object";

/** Namespace stubs preserve Cap'n Web's typed methods, capabilities, and promise pipelining. */
export type NodeRuntimeObjects<TBindings extends NodeRuntimeObjectBindings> = {
  [K in keyof TBindings]: { get(name: string): NodeRuntimeObjectStub<TBindings[K]> };
};

type NodeObjectWorkerPersistence = NodeObjectWorkerOptions["persistence"];

const defaultGraftDatabaseOperations = defineGraftDatabaseOperations(
  new URL("../graft/graft-database-operations.js", import.meta.url),
  "createSqlitePragmaGraftDatabaseOperations",
  null,
);

type NodeObjectDirectory = {
  objectIds(): string[];
  resolveObject(binding: string, name: string): NodeObjectWorkerPersistence;
  close(): void;
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

/** Owns local file-backed object workers for development and deterministic runtime scenarios. */
export function createNodeObjectRuntime<TBindings extends NodeRuntimeObjectBindings>(options: {
  directory: string;
  objects: TBindings;
  clock: NodeRuntimeClock;
}) {
  validateNodeRuntimeObjectBindings(options.objects);
  const storage = new SqliteBackofficeObjectStorage(options.directory);
  return createNodeObjectRuntimeWithDirectory({
    objects: options.objects,
    clock: options.clock,
    directory: {
      objectIds: () => storage.objectIds(),
      resolveObject: () => ({ kind: "local", directory: options.directory }),
      close: () => {
        storage.close();
      },
    },
  });
}

/** Owns single-writer object workers whose SQLite state is synchronously durable in Graft. */
export function createGraftNodeObjectRuntime<TBindings extends NodeRuntimeObjectBindings>(options: {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
}) {
  return createGraftNodeObjectRuntimeWithDatabaseOperations({
    ...options,
    databaseOperations: defaultGraftDatabaseOperations,
  });
}

/** Owns Graft object workers using an importable database-operations collaborator. */
export function createGraftNodeObjectRuntimeWithDatabaseOperations<
  TBindings extends NodeRuntimeObjectBindings,
>(options: {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
  databaseOperations: ImportableGraftDatabaseOperations;
}) {
  validateNodeRuntimeObjectBindings(options.objects);
  const directory = new GraftObjectDirectory(options.storage);
  return createNodeObjectRuntimeWithDirectory({
    objects: options.objects,
    clock: options.clock,
    directory: {
      objectIds: () => directory.objectIds(),
      resolveObject(binding, name) {
        const objectId = `${binding}:${name}`;
        return {
          kind: "graft",
          localTag: `object-clone-${randomUUID()}`,
          remoteLogId: directory.resolveObjectRemoteLogId(objectId),
          operations: options.databaseOperations,
        };
      },
      close: () => {
        directory.close();
      },
    },
  });
}

/** Owns workers admitted only after a durable control claim and object-log fencing commit. */
export function createAuthorityBoundGraftNodeObjectRuntime<
  TBindings extends NodeRuntimeObjectBindings,
>(options: {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
  nodeLease: GraftNodeLease;
}) {
  return createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations({
    ...options,
    databaseOperations: defaultGraftDatabaseOperations,
  });
}

/** Owns authority-bound Graft workers using injectable object-log management operations. */
export function createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations<
  TBindings extends NodeRuntimeObjectBindings,
>(options: {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
  nodeLease: GraftNodeLease;
  databaseOperations: ImportableGraftDatabaseOperations;
}) {
  validateNodeRuntimeObjectBindings(options.objects);
  registerGraftRuntimeNode(options.storage, options.clock, options.nodeLease);
  const directory = new GraftObjectDirectory(options.storage);
  return createNodeObjectRuntimeWithDirectory({
    objects: options.objects,
    clock: options.clock,
    directory: {
      objectIds: () => directory.objectIds(),
      resolveObject(binding, name) {
        const objectId = `${binding}:${name}`;
        return {
          kind: "authority-bound-graft",
          remoteLogId: directory.resolveObjectRemoteLogId(objectId),
          operations: options.databaseOperations,
          storage: options.storage,
          nodeLease: options.nodeLease,
          maxFenceAttempts: DEFAULT_GRAFT_OBJECT_ACTIVATION_FENCE_ATTEMPTS,
        };
      },
      close: () => {
        directory.close();
      },
    },
  });
}

/**
 * Owns one worker per object identity; serving requests and processing alarms share an instance.
 * Callers must finish application RPC and stop scheduling work before cleanup.
 */
function createNodeObjectRuntimeWithDirectory<
  TBindings extends NodeRuntimeObjectBindings,
>(options: { directory: NodeObjectDirectory; objects: TBindings; clock: NodeRuntimeClock }) {
  const workers = new Map<string, ReturnType<typeof startObjectWorker>>();
  const activeOutputScope = new AsyncLocalStorage<ReturnType<typeof createRuntimeOutputScope>>();
  let closed = false;
  let cleanup: Promise<void> | null = null;

  function requireOpen() {
    if (closed) {
      throw new Error("NODE_OBJECT_RUNTIME_CLOSED");
    }
  }

  function startObjectWorker(binding: string, name: string) {
    const definition = options.objects[binding];
    const persistence = options.directory.resolveObject(binding, name);
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
    const session = createNodeMessagePortRpcSession<NodeObjectWorkerControl>(port1, undefined);
    worker.once("error", (error) => {
      session.abort(error);
    });
    worker.once("exit", (code) => {
      session.abort(new Error(`NODE_OBJECT_WORKER_EXITED:${binding}:${name}:${code}`));
    });
    let disconnected = false;
    session.remote.onRpcBroken(() => {
      disconnected = true;
    });
    const object = session.remote.getObject();
    return {
      object,
      control: session.remote,
      async cleanup() {
        try {
          if (!disconnected) {
            await session.remote.shutdown();
          }
        } catch (error) {
          if (!disconnected) {
            throw error;
          }
        } finally {
          object[Symbol.dispose]();
          session.abort(new Error("NODE_OBJECT_RUNTIME_CLOSED"));
          await worker.terminate();
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
    return worker;
  }

  function createRuntimeOutputScope() {
    const outputScopeId = randomUUID();
    const scopedObjects = new Map<
      ReturnType<typeof startObjectWorker>,
      ReturnType<ReturnType<typeof startObjectWorker>["control"]["getObjectForOutputScope"]>
    >();
    let released = false;

    return {
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
        const results = await Promise.allSettled(
          [...scopedObjects].map(async ([worker, object]) => {
            try {
              await worker.control.releaseOutputScope(outputScopeId);
            } finally {
              object[Symbol.dispose]();
            }
          }),
        );
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
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
          const worker = getObjectWorker(binding, name);
          return activeOutputScope.getStore()?.getObject(worker) ?? worker.object.dup();
        },
      },
    ]),
  ) as unknown as NodeRuntimeObjects<TBindings>;

  const runtime = {
    objects,
    /** Holds external output until every object touched by the operation proves its state durable. */
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
      if (outcome.kind === "failure") {
        throw outcome.error;
      }
      return outcome.value;
    },
    async discoverPersistedObjects() {
      requireOpen();
      const results = await Promise.allSettled(
        options.directory.objectIds().map(async (id) => {
          const separator = id.indexOf(":");
          const binding = id.slice(0, separator);
          if (!Object.hasOwn(options.objects, binding)) {
            throw new Error(`NODE_OBJECT_RUNTIME_UNKNOWN_PERSISTED_OBJECT:${id}`);
          }
          getObjectWorker(binding, id.slice(separator + 1));
        }),
      );
      throwObjectRuntimeFailures(results, "NODE_OBJECT_RUNTIME_DISCOVERY_FAILED");
      await runWorkerStage(async (control) => {
        await control.prepareForEvent();
      }, "NODE_OBJECT_RUNTIME_INITIALIZATION_FAILED");
    },
    async drainAlarms() {
      const nowEpochMs = readNodeRuntimeClock(options.clock);
      await runWorkerStage(async (control) => {
        await control.deliverDueAlarm(nowEpochMs);
      }, "NODE_OBJECT_RUNTIME_ALARM_DELIVERY_FAILED");
    },
    async drainWaitUntil() {
      await runWorkerStage(async (control) => {
        await control.drainWaitUntil();
      }, "NODE_OBJECT_RUNTIME_WAIT_UNTIL_FAILED");
    },
    async tick() {
      requireOpen();
      await runNodeBackofficeAlarmTick(runtime);
    },
    /** Requires settled application RPC and streams; drains registered waitUntil work, not capability calls. */
    cleanup(): Promise<void> {
      cleanup ??= (async () => {
        closed = true;
        try {
          const results = await Promise.allSettled(
            [...workers.values()].map(async (worker) => {
              await worker.cleanup();
            }),
          );
          throwObjectRuntimeFailures(results, "NODE_OBJECT_RUNTIME_CLEANUP_FAILED");
        } finally {
          options.directory.close();
        }
      })();
      return cleanup;
    },
  };
  return runtime;
}

function registerGraftRuntimeNode(
  storage: GraftNodeRuntimeStorage,
  clock: NodeRuntimeClock,
  nodeLease: GraftNodeLease,
): void {
  const controlStore = new GraftControlStore(storage);
  try {
    const nowEpochMs = readNodeRuntimeClock(clock);
    const result = controlStore.registerNode({
      commandId: randomUUID(),
      commandCreatedAtMs: nowEpochMs,
      input: { lease: nodeLease },
    });
    if (result.outcome !== "registered") {
      throw new Error(`GRAFT_NODE_RUNTIME_REGISTRATION_REJECTED:${nodeLease.nodeId}`);
    }
  } finally {
    controlStore.close();
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
