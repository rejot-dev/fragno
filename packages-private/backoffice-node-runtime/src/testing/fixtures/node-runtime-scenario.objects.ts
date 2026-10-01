import { isMainThread, threadId } from "node:worker_threads";

import { RpcTarget } from "capnweb";

import type { NodeRuntimeObjectContext } from "../../runtime/node-runtime-object";

/** Scenario object retains in-memory state across fetch, RPC, and alarm entry points. */
export function createQueueObject({ state, nowEpochMs, name }: NodeRuntimeObjectContext) {
  let memoryDeliveries = 0;
  let initializationCompleted = false;
  const initialization = state.blockConcurrencyWhile(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    if ((await state.storage.get("initialized")) === undefined) {
      await state.storage.put("initialized", true);
    }
    initializationCompleted = true;
  });
  void initialization.catch(() => {});
  return {
    async schedule(message: string, delayMs: number) {
      await state.storage.put("message", message);
      await state.storage.setAlarm(nowEpochMs() + delayMs);
      return { scheduled: true, threadId, isMainThread };
    },
    initialized() {
      return { initialized: initializationCompleted, threadId };
    },
    async fetch(request: Request) {
      if (request.method === "POST") {
        await state.storage.put("message", await request.text());
        return new Response(null, { status: 204 });
      }
      return Response.json({
        name,
        message: (await state.storage.get("message")) ?? null,
        initialized: await state.storage.get("initialized"),
        deliveries: (await state.storage.get("deliveries")) ?? 0,
        memoryDeliveries,
        processedByThread: (await state.storage.get("processedByThread")) ?? null,
        alarm: await state.storage.getAlarm(),
        servedByThread: threadId,
        isMainThread,
      });
    },
    async alarm() {
      memoryDeliveries += 1;
      await state.storage.put(
        "deliveries",
        ((await state.storage.get<number>("deliveries")) ?? 0) + 1,
      );
      await state.storage.put("processedByThread", threadId);
      state.waitUntil(state.storage.put("completedBackgroundWork", true));
    },
    async completedBackgroundWork() {
      return (await state.storage.get<boolean>("completedBackgroundWork")) ?? false;
    },
  };
}

/** A second binding verifies that object identities own distinct worker threads. */
export function createReceiptObject({ state }: NodeRuntimeObjectContext) {
  return {
    async record(message: string) {
      await state.storage.put("receipt", message);
      return threadId;
    },
    async fetch(_request: Request) {
      return Response.json({ receipt: (await state.storage.get("receipt")) ?? null, threadId });
    },
  };
}

class CounterCapability extends RpcTarget {
  #count = 0;

  add(delta: number) {
    this.#count += delta;
    return this.#count;
  }
}

/** Worker values exercise Cap'n Web copy semantics, capabilities, and streaming fetch responses. */
export function createValuesObject({ state }: NodeRuntimeObjectContext) {
  return {
    async exchange(value: { text: string; createdAt: Date; bytes: Uint8Array; count: bigint }) {
      await state.storage.put("value", value);
      value.text = "changed inside worker";
      value.bytes[0] = 9;
      return value;
    },
    async read() {
      return await state.storage.get("value");
    },
    async echoUnknown(value: unknown) {
      return value;
    },
    async callback(callback: (message: string) => Promise<string>) {
      return await callback(`worker ${threadId}`);
    },
    counter() {
      return new CounterCapability();
    },
    async fetch(request: Request) {
      if (new URL(request.url).pathname === "/stream") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first "));
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            },
          }),
          { status: 202, headers: { "x-object-thread": String(threadId) } },
        );
      }
      return Response.json(
        {
          url: request.url,
          method: request.method,
          header: request.headers.get("x-client"),
          body: await request.text(),
          threadId,
          isMainThread,
        },
        { status: 201, headers: { "x-worker-response": "true" } },
      );
    },
  };
}

/** Alarm retries reuse the same object, including its unpersisted attempt counter. */
export function createRetryObject({ state, nowEpochMs }: NodeRuntimeObjectContext) {
  let memoryAttempts = 0;
  return {
    async fetch(request: Request) {
      if (request.method === "POST") {
        await state.storage.setAlarm(nowEpochMs());
        return new Response(null, { status: 204 });
      }
      return Response.json({
        attempts: (await state.storage.get("attempts")) ?? 0,
        memoryAttempts,
        alarm: await state.storage.getAlarm(),
      });
    },
    async alarm() {
      memoryAttempts += 1;
      const attempts = ((await state.storage.get<number>("attempts")) ?? 0) + 1;
      await state.storage.put("attempts", attempts);
      if (attempts === 1) {
        throw new Error("EXPECTED_SCENARIO_ALARM_FAILURE", {
          cause: new TypeError("EXPECTED_ALARM_CAUSE"),
        });
      }
      if (attempts === 2) {
        await state.storage.setAlarm(nowEpochMs() + 10);
      }
    },
  };
}

class StatefulObject {
  #count = 0;

  increment(delta: number) {
    this.#count += delta;
    return this.#count;
  }

  fetch(_request: Request) {
    return Response.json({ count: this.#count, threadId });
  }
}

/** Ordinary classes keep private state and synchronous methods behind the worker's RPC adapter. */
export function createClassObject() {
  return new StatefulObject();
}

/** Serialized RPC failures retain their error type, message, and cause. */
export function createFailingObject() {
  return {
    async fetch() {
      return new Response(null);
    },
    async fail(): Promise<void> {
      throw new TypeError("EXPECTED_SCENARIO_RPC_FAILURE", {
        cause: new Error("EXPECTED_RPC_CAUSE"),
      });
    },
    async crash(): Promise<void> {
      process.exit(7);
    },
  };
}

class BackgroundOperationCapability extends RpcTarget {
  readonly #state: NodeRuntimeObjectContext["state"];

  constructor(state: NodeRuntimeObjectContext["state"]) {
    super();
    this.#state = state;
  }

  async completeOperation(callback: () => Promise<void>) {
    await callback();
    await this.#state.storage.put("capabilityOperationFinished", true);
  }
}

/** Cleanup must settle background work before terminating its object worker and closing SQLite. */
export function createBackgroundObject({ state }: NodeRuntimeObjectContext) {
  return {
    async startBackground() {
      state.waitUntil(
        (async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
          await state.storage.put("backgroundFinished", true);
        })(),
      );
    },
    async completeOperation(callback: () => Promise<void>) {
      await callback();
      await state.storage.put("operationFinished", true);
    },
    operationCapability() {
      return new BackgroundOperationCapability(state);
    },
    async completeRequest(request: Request, callback: () => Promise<void>) {
      await callback();
      await state.storage.put("requestBody", await request.text());
    },
    async fetch() {
      return Response.json({
        requestBody: (await state.storage.get("requestBody")) ?? null,
        backgroundFinished: (await state.storage.get("backgroundFinished")) ?? false,
        operationFinished: (await state.storage.get("operationFinished")) ?? false,
        capabilityOperationFinished:
          (await state.storage.get("capabilityOperationFinished")) ?? false,
        threadId,
      });
    },
  };
}
