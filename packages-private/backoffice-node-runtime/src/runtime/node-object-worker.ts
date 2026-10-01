import { workerData, type MessagePort } from "node:worker_threads";

import { RpcTarget } from "capnweb";

import { createNodeMessagePortRpcSession } from "../rpc/node-message-port-rpc";
import { SqliteDurableObjectState } from "../sqlite/sqlite-durable-object-state";
import { SqliteObjectCoordination } from "../sqlite/sqlite-object-coordination";
import { SqliteBackofficeObjectStorage } from "../sqlite/sqlite-object-storage";
import {
  LocalDurableObjectNamespace,
  ProcessLocalObjectExecutionCoordinator,
} from "./local-durable-objects";
import { readNodeRuntimeClock, type NodeRuntimeClock } from "./node-runtime-clock";
import type { NodeRuntimeObjectFactory } from "./node-runtime-object";

/** Bootstrap data carries module identity and shared clock state, never application RPC values. */
export type NodeObjectWorkerOptions = {
  port: MessagePort;
  directory: string;
  binding: string;
  name: string;
  moduleUrl: string;
  exportName: string;
  clock: NodeRuntimeClock;
};

/** Private control RPC shares the worker and object instance used by public fetch and RPC calls. */
export type NodeObjectWorkerControl = {
  getObject(): Promise<RpcTarget>;
  prepareForEvent(): Promise<void>;
  deliverDueAlarm(nowEpochMs: number): Promise<void>;
  drainWaitUntil(): Promise<void>;
  shutdown(): Promise<void>;
};

async function createWorkerObject(options: NodeObjectWorkerOptions) {
  const module = (await import(options.moduleUrl)) as Record<string, unknown>;
  const exportedFactory = module[options.exportName];
  if (typeof exportedFactory !== "function") {
    throw new Error(
      `NODE_OBJECT_WORKER_FACTORY_MISSING:${options.moduleUrl}:${options.exportName}`,
    );
  }
  const createObject = exportedFactory as NodeRuntimeObjectFactory;
  const storage = new SqliteBackofficeObjectStorage(options.directory);
  const coordination = new SqliteObjectCoordination(storage);
  const executionCoordinator = new ProcessLocalObjectExecutionCoordinator();
  try {
    const namespace = new LocalDurableObjectNamespace({
      name: options.binding,
      executionCoordinator,
      createState: (id) => new SqliteDurableObjectState(id, storage, coordination),
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
    // The capability exposes handlers, not state, lifecycle operations, or arbitrary instance fields.
    // A RpcTarget adapter also supports factories returning ordinary object literals or classes.
    const target = new Proxy(new RpcTarget(), {
      get(target, property): unknown {
        const targetProperties = target as unknown as Record<PropertyKey, unknown>;
        if (typeof property !== "string" || property === "constructor") {
          return targetProperties[property];
        }
        if (property === "then" || property === "alarm") {
          return undefined;
        }
        const method = objectProperties[property];
        return typeof method === "function" ? method.bind(object) : undefined;
      },
    });
    await namespace.restorePersisted(id);
    return {
      target,
      async prepareForEvent() {
        await instance.state.prepareForEvent();
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
          await coordination.waitForIdle();
          storage.close();
        }
      },
    };
  } catch (error) {
    await coordination.waitForIdle();
    storage.close();
    throw error;
  }
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
