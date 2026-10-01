import { MessageChannel, Worker } from "node:worker_threads";

import type { RpcStub } from "capnweb";

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

/**
 * Owns one worker per object identity; serving requests and processing alarms share an instance.
 * Callers must finish application RPC and stop scheduling work before cleanup.
 */
export function createNodeObjectRuntime<TBindings extends NodeRuntimeObjectBindings>(options: {
  directory: string;
  objects: TBindings;
  clock: NodeRuntimeClock;
}) {
  for (const [binding, definition] of Object.entries(options.objects)) {
    if (binding.length === 0 || binding.includes(":")) {
      throw new Error(`NODE_OBJECT_RUNTIME_INVALID_BINDING:${binding}`);
    }
    if (new URL(definition.moduleUrl).protocol !== "file:" || definition.exportName.length === 0) {
      throw new Error(`NODE_OBJECT_RUNTIME_INVALID_MODULE:${binding}`);
    }
  }
  const storage = new SqliteBackofficeObjectStorage(options.directory);
  const workers = new Map<string, ReturnType<typeof startObjectWorker>>();
  let closed = false;
  let cleanup: Promise<void> | null = null;

  function requireOpen() {
    if (closed) {
      throw new Error("NODE_OBJECT_RUNTIME_CLOSED");
    }
  }

  function startObjectWorker(binding: string, name: string) {
    const { port1, port2 } = new MessageChannel();
    const definition = options.objects[binding];
    const workerOptions: NodeObjectWorkerOptions = {
      port: port2,
      binding,
      name,
      directory: options.directory,
      moduleUrl: definition.moduleUrl,
      exportName: definition.exportName,
      clock: options.clock,
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
      { get: (name: string) => getObjectWorker(binding, name).object.dup() },
    ]),
  ) as unknown as NodeRuntimeObjects<TBindings>;

  const runtime = {
    objects,
    async discoverPersistedObjects() {
      requireOpen();
      const results = await Promise.allSettled(
        storage.objectIds().map(async (id) => {
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
          storage.close();
        }
      })();
      return cleanup;
    },
  };
  return runtime;
}
