import { afterAll, assert, beforeAll, expect, test } from "vitest";

import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";
import {
  createManualNodeRuntimeClock,
  type NodeRuntimeClock,
} from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import {
  defineNodeRuntimeObject,
  type NodeRuntimeObjectBindings,
} from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  createNodeRuntimeScenarioRuntime,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type {
  createBackgroundObject,
  createClassObject,
  createFailingObject,
  createQueueObject,
} from "../testing/fixtures/node-runtime-scenario.objects";

const moduleUrl = new URL("../testing/fixtures/node-runtime-scenario.objects.ts", import.meta.url);
const queue = defineNodeRuntimeObject<typeof createQueueObject>(moduleUrl, "createQueueObject");
const failing = defineNodeRuntimeObject<typeof createFailingObject>(
  moduleUrl,
  "createFailingObject",
);
const background = defineNodeRuntimeObject<typeof createBackgroundObject>(
  moduleUrl,
  "createBackgroundObject",
);
const classObject = defineNodeRuntimeObject<typeof createClassObject>(
  moduleUrl,
  "createClassObject",
);

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

function startRuntime<TBindings extends NodeRuntimeObjectBindings>(options: {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
}) {
  return createNodeRuntimeScenarioRuntime({ ...options, objectEviction: { kind: "disabled" } });
}

test("a restarted runtime discovers a persisted alarm and serves it from the new object worker", async () => {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const first = startRuntime({ storage, objects: { QUEUE: queue }, clock: clock.source });
  try {
    const scheduled = await first.objects.QUEUE.get("v1:org:one").schedule("persisted", 100);
    await first.cleanup();
    clock.advanceBy(100);
    const restarted = startRuntime({ storage, objects: { QUEUE: queue }, clock: clock.source });
    try {
      await restarted.tick();
      const response = await restarted.objects.QUEUE.get("v1:org:one").fetch(
        new Request("https://scenario.test/state"),
      );
      const body = (await response.json()) as { servedByThread: number; processedByThread: number };
      expect(body).toMatchObject({
        message: "persisted",
        deliveries: 1,
        memoryDeliveries: 1,
        alarm: null,
      });
      assert.notEqual(body.servedByThread, scheduled.threadId);
      assert.equal(body.servedByThread, body.processedByThread);
    } finally {
      await restarted.cleanup();
    }
  } finally {
    await first.cleanup();
  }
});

test("a manual idle sweep evicts a resident worker and restores durable state on demand", async () => {
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeRuntimeScenarioRuntime({
    storage: environment.createStorage(),
    objects: { QUEUE: queue },
    clock: clock.source,
    objectEviction: { kind: "manual", idleTimeoutMs: 1_000 },
  });
  try {
    using object = runtime.objects.QUEUE.get("one");
    const scheduled = await object.schedule("survives eviction", 10_000);
    clock.advanceMonotonicBy(1_000);
    await runtime.sweepIdleObjects();
    using restoredObject = runtime.objects.QUEUE.get("one");
    const response = await restoredObject.fetch(new Request("https://scenario.test/state"));
    const body = (await response.json()) as { message: string; servedByThread: number };
    assert.equal(body.message, "survives eviction");
    assert.notEqual(body.servedByThread, scheduled.threadId);
  } finally {
    await runtime.cleanup();
  }
});

test("an idle sweep preserves a worker while an object event is active", async () => {
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeRuntimeScenarioRuntime({
    storage: environment.createStorage(),
    objects: { BACKGROUND: background },
    clock: clock.source,
    objectEviction: { kind: "manual", idleTimeoutMs: 1_000 },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    using object = runtime.objects.BACKGROUND.get("one");
    const initialResponse = await object.fetch(new Request("https://scenario.test/state"));
    const initialState = (await initialResponse.json()) as { threadId: number };
    const operation = object.completeOperation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    clock.advanceMonotonicBy(1_000);
    await runtime.sweepIdleObjects();
    release.resolve();
    await operation;
    const activeResponse = await object.fetch(new Request("https://scenario.test/state"));
    const activeState = (await activeResponse.json()) as { threadId: number };
    assert.equal(activeState.threadId, initialState.threadId);
  } finally {
    release.resolve();
    await runtime.cleanup();
  }
});

test("automatic idle sweeps retire inactive in-memory object instances", async () => {
  const sweepFailures: unknown[] = [];
  const runtime = createNodeRuntimeScenarioRuntime({
    storage: environment.createStorage(),
    objects: { COUNTER: classObject },
    clock: { kind: "system" },
    objectEviction: {
      kind: "automatic",
      idleTimeoutMs: 200,
      sweepIntervalMs: 50,
      reportError(error) {
        sweepFailures.push(error);
      },
    },
  });
  const object = runtime.objects.COUNTER.get("one");
  try {
    assert.equal(await object.increment(1), 1);
    let activationEvicted = false;
    for (let attempt = 0; attempt < 5 && !activationEvicted; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 350);
      });
      try {
        await object.increment(0);
      } catch {
        activationEvicted = true;
      }
    }
    assert(activationEvicted);
    await runtime.sweepIdleObjects();
    using restoredObject = runtime.objects.COUNTER.get("one");
    assert.equal(await restoredObject.increment(1), 1);
    assert.deepEqual(sweepFailures, []);
  } finally {
    object[Symbol.dispose]();
    await runtime.cleanup();
  }
});

test("caller-awaited pipelined schedule RPC persists across cleanup", async () => {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const runtime = startRuntime({ storage, objects: { QUEUE: queue }, clock: clock.source });
  try {
    using object = runtime.objects.QUEUE.get("one");
    await expect(object.schedule("awaited", 100)).resolves.toMatchObject({ scheduled: true });
    await runtime.cleanup();
    const restarted = startRuntime({ storage, objects: { QUEUE: queue }, clock: clock.source });
    try {
      const response = await restarted.objects.QUEUE.get("one").fetch(
        new Request("https://scenario.test/state"),
      );
      expect(await response.json()).toMatchObject({
        initialized: true,
        message: "awaited",
        alarm: 100,
      });
    } finally {
      await restarted.cleanup();
    }
  } finally {
    await runtime.cleanup();
  }
});

test("caller-awaited returned capability RPC persists its callback write across cleanup", async () => {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const runtime = startRuntime({
    storage,
    objects: { BACKGROUND: background },
    clock: clock.source,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    using capability = await runtime.objects.BACKGROUND.get("one").operationCapability();
    const operation = Promise.resolve(
      capability.completeOperation(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    release.resolve();
    await expect(operation).resolves.toBeUndefined();
    await runtime.cleanup();
    const restarted = startRuntime({
      storage,
      objects: { BACKGROUND: background },
      clock: clock.source,
    });
    try {
      const response = await restarted.objects.BACKGROUND.get("one").fetch(
        new Request("https://scenario.test/state"),
      );
      expect(await response.json()).toMatchObject({ capabilityOperationFinished: true });
    } finally {
      await restarted.cleanup();
    }
  } finally {
    release.resolve();
    await runtime.cleanup();
  }
});

test("caller finishes a streamed request and its Graft write before cleanup", async () => {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const runtime = startRuntime({
    storage,
    objects: { BACKGROUND: background },
    clock: clock.source,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = new TransformStream<Uint8Array, Uint8Array>();
  const writer = body.writable.getWriter();
  try {
    const request = new Request("https://scenario.test/body", {
      method: "POST",
      body: body.readable,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const operation = Promise.resolve(
      runtime.objects.BACKGROUND.get("one").completeRequest(request, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const upload = (async () => {
      await writer.write(new TextEncoder().encode("body delivered before shutdown"));
      await writer.close();
    })();
    release.resolve();
    await Promise.all([operation, upload]);
    await runtime.cleanup();
    const restarted = startRuntime({
      storage,
      objects: { BACKGROUND: background },
      clock: clock.source,
    });
    try {
      const response = await restarted.objects.BACKGROUND.get("one").fetch(
        new Request("https://scenario.test/state"),
      );
      expect(await response.json()).toMatchObject({
        requestBody: "body delivered before shutdown",
      });
    } finally {
      await restarted.cleanup();
    }
  } finally {
    release.resolve();
    await writer.abort();
    writer.releaseLock();
    await runtime.cleanup();
  }
});

test("an output gate owns namespace handles until its outer operation completes", async () => {
  const clock = createManualNodeRuntimeClock(0);
  const runtime = startRuntime({
    storage: environment.createStorage(),
    objects: { COUNTER: classObject },
    clock: clock.source,
  });
  let escapedObject: ReturnType<typeof runtime.objects.COUNTER.get> | null = null;
  try {
    await runtime.runWithOutputGate(async () => {
      const object = runtime.objects.COUNTER.get("one");
      escapedObject = object;
      assert.equal(await object.increment(2), 2);
      await runtime.runWithOutputGate(async () => {
        assert.equal(await object.increment(1), 3);
      });
      assert.equal(await object.increment(1), 4);
    });
    const disposedObject = escapedObject as ReturnType<typeof runtime.objects.COUNTER.get> | null;
    assert(disposedObject);
    await expect(disposedObject.increment(1)).rejects.toThrow(
      "Attempted to use RPC stub after it has been disposed.",
    );
    using freshObject = runtime.objects.COUNTER.get("one");
    assert.equal(await freshObject.increment(2), 6);
  } finally {
    await runtime.cleanup();
  }
});

test("cleanup settles worker waitUntil work and is idempotent", async () => {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const runtime = startRuntime({
    storage,
    objects: { BACKGROUND: background },
    clock: clock.source,
  });
  try {
    using object = runtime.objects.BACKGROUND.get("one");
    await object.completeOperation(async () => {});
    await object.startBackground();
    const shutdown = runtime.cleanup();
    assert.strictEqual(runtime.cleanup(), shutdown);
    expect(() => runtime.objects.BACKGROUND.get("one")).toThrow("NODE_OBJECT_RUNTIME_CLOSED");
    await shutdown;
    const restarted = startRuntime({
      storage,
      objects: { BACKGROUND: background },
      clock: clock.source,
    });
    try {
      const response = await restarted.objects.BACKGROUND.get("one").fetch(
        new Request("https://scenario.test/state"),
      );
      expect(await response.json()).toMatchObject({
        backgroundFinished: true,
        operationFinished: true,
      });
    } finally {
      await restarted.cleanup();
    }
  } finally {
    await runtime.cleanup();
  }
});

test("worker exit rejects pending and future RPC calls instead of hanging", async () => {
  const clock = createManualNodeRuntimeClock(0);
  const runtime = startRuntime({
    storage: environment.createStorage(),
    objects: { FAILING: failing },
    clock: clock.source,
  });
  try {
    using object = runtime.objects.FAILING.get("one");
    await expect(object.crash()).rejects.toThrow(
      /NODE_MESSAGE_PORT_RPC_CLOSED|NODE_OBJECT_WORKER_EXITED/,
    );
    await expect(object.fail()).rejects.toThrow(
      /NODE_MESSAGE_PORT_RPC_CLOSED|NODE_OBJECT_WORKER_EXITED/,
    );
  } finally {
    await runtime.cleanup();
  }
});

test("missing factory exports fail over RPC while worker cleanup still succeeds", async () => {
  const clock = createManualNodeRuntimeClock(0);
  const missing = defineNodeRuntimeObject<typeof createQueueObject>(moduleUrl, "missingFactory");
  const runtime = startRuntime({
    storage: environment.createStorage(),
    objects: { MISSING: missing },
    clock: clock.source,
  });
  try {
    await expect(runtime.objects.MISSING.get("one").schedule("unused", 0)).rejects.toThrow(
      "NODE_OBJECT_WORKER_FACTORY_MISSING",
    );
  } finally {
    await runtime.cleanup();
  }
});
