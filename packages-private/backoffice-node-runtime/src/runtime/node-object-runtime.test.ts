import { assert, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type {
  createBackgroundObject,
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

test("a restarted runtime discovers a persisted alarm and serves it from the new object worker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-restart-"));
  const clock = createManualNodeRuntimeClock(0);
  const first = createNodeObjectRuntime({
    directory,
    objects: { QUEUE: queue },
    clock: clock.source,
  });
  try {
    const scheduled = await first.objects.QUEUE.get("v1:org:one").schedule("persisted", 100);
    await first.cleanup();
    clock.advanceBy(100);
    const restarted = createNodeObjectRuntime({
      directory,
      objects: { QUEUE: queue },
      clock: clock.source,
    });
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
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller-awaited pipelined schedule RPC persists across cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-pipelined-cleanup-"));
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeObjectRuntime({
    directory,
    objects: { QUEUE: queue },
    clock: clock.source,
  });
  try {
    using object = runtime.objects.QUEUE.get("one");
    await expect(object.schedule("awaited", 100)).resolves.toMatchObject({ scheduled: true });
    await runtime.cleanup();

    const restarted = createNodeObjectRuntime({
      directory,
      objects: { QUEUE: queue },
      clock: clock.source,
    });
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
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller-awaited returned capability RPC persists its callback write across cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-capability-cleanup-"));
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeObjectRuntime({
    directory,
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

    const restarted = createNodeObjectRuntime({
      directory,
      objects: { BACKGROUND: background },
      clock: clock.source,
    });
    try {
      const response = await restarted.objects.BACKGROUND.get("one").fetch();
      expect(await response.json()).toMatchObject({ capabilityOperationFinished: true });
    } finally {
      await restarted.cleanup();
    }
  } finally {
    release.resolve();
    await runtime.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller finishes a streamed request and its SQLite write before cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-stream-cleanup-"));
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeObjectRuntime({
    directory,
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

    const restarted = createNodeObjectRuntime({
      directory,
      objects: { BACKGROUND: background },
      clock: clock.source,
    });
    try {
      const response = await restarted.objects.BACKGROUND.get("one").fetch();
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
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup settles worker waitUntil work and is idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-cleanup-"));
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeObjectRuntime({
    directory,
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
    const restarted = createNodeObjectRuntime({
      directory,
      objects: { BACKGROUND: background },
      clock: clock.source,
    });
    try {
      const response = await restarted.objects.BACKGROUND.get("one").fetch();
      expect(await response.json()).toMatchObject({
        backgroundFinished: true,
        operationFinished: true,
      });
    } finally {
      await restarted.cleanup();
    }
  } finally {
    await runtime.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker exit rejects pending and future RPC calls instead of hanging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-crash-"));
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeObjectRuntime({
    directory,
    objects: { FAILING: failing },
    clock: clock.source,
  });
  try {
    const object = runtime.objects.FAILING.get("one");
    await expect(object.crash()).rejects.toThrow(
      /NODE_MESSAGE_PORT_RPC_CLOSED|NODE_OBJECT_WORKER_EXITED/,
    );
    await expect(object.fail()).rejects.toThrow(
      /NODE_MESSAGE_PORT_RPC_CLOSED|NODE_OBJECT_WORKER_EXITED/,
    );
  } finally {
    await runtime.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing factory exports fail over RPC while worker cleanup still succeeds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-object-invalid-module-"));
  const clock = createManualNodeRuntimeClock(0);
  const missing = defineNodeRuntimeObject<typeof createQueueObject>(moduleUrl, "missingFactory");
  const runtime = createNodeObjectRuntime({
    directory,
    objects: { MISSING: missing },
    clock: clock.source,
  });
  try {
    await expect(runtime.objects.MISSING.get("one").schedule("unused", 0)).rejects.toThrow(
      "NODE_OBJECT_WORKER_FACTORY_MISSING",
    );
  } finally {
    await runtime.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
