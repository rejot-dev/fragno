import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { isMainThread, threadId } from "node:worker_threads";

// Exercise the built worker entry point, exactly as an installed runtime does.
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type {
  createQueueObject,
  createReceiptObject,
  createValuesObject,
  createRetryObject,
  createFailingObject,
  createClassObject,
} from "./fixtures/node-runtime-scenario.objects";

const moduleUrl = new URL("./fixtures/node-runtime-scenario.objects.ts", import.meta.url);
const queue = defineNodeRuntimeObject<typeof createQueueObject>(moduleUrl, "createQueueObject");
const receipt = defineNodeRuntimeObject<typeof createReceiptObject>(
  moduleUrl,
  "createReceiptObject",
);
const values = defineNodeRuntimeObject<typeof createValuesObject>(moduleUrl, "createValuesObject");
const retry = defineNodeRuntimeObject<typeof createRetryObject>(moduleUrl, "createRetryObject");
const failing = defineNodeRuntimeObject<typeof createFailingObject>(
  moduleUrl,
  "createFailingObject",
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

function request(pathname: string, init: RequestInit = {}): Request {
  return new Request(`https://node-scenario.test${pathname}`, init);
}

test("fetch, RPC, and competing alarm ticks share one object instance in its own worker", async () => {
  const objectThreads = new Set<number>();
  let queueThread = 0;
  const result = await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "one-worker-per-object",
      storage: environment.createStorage(),
      initialTimeEpochMs: 1_000,
      objectEviction: { kind: "disabled" },
      objects: { QUEUE: queue, RECEIPT: receipt },
      server: ({ objects }) => ({
        async fetch(req) {
          assert.equal(isMainThread, true);
          const url = new URL(req.url);
          const name = url.searchParams.get("name") ?? "v1:org:org-1";
          if (url.pathname === "/schedule") {
            const message = await req.text();
            const result = await objects.QUEUE.get(name).schedule(message, 100);
            objectThreads.add(await objects.RECEIPT.get(name).record(message));
            return Response.json(result);
          }
          if (url.pathname === "/receipt") {
            return await objects.RECEIPT.get(name).fetch(req);
          }
          return await objects.QUEUE.get(name).fetch(req);
        },
      }),
      steps: ({ server, then, alarms, background, clock, concurrent }) => [
        server.fetch(
          request("/schedule", { method: "POST", body: "hello from main" }),
          async (response) => {
            const body = (await response.json()) as { threadId: number; isMainThread: boolean };
            queueThread = body.threadId;
            objectThreads.add(queueThread);
            assert.notEqual(queueThread, threadId);
            expect(body).toMatchObject({ scheduled: true, isMainThread: false });
          },
        ),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({
            name: "v1:org:org-1",
            message: "hello from main",
            initialized: true,
            deliveries: 0,
            memoryDeliveries: 0,
            processedByThread: null,
            alarm: 1_100,
            servedByThread: queueThread,
            isMainThread: false,
          });
        }),
        server.fetch(request("/receipt"), async (response) => {
          expect(await response.json()).toMatchObject({ receipt: "hello from main" });
        }),
        server.fetch(
          request("/state?name=org-2", { method: "POST", body: "isolated object" }),
          (response) => {
            assert.equal(response.status, 204);
          },
        ),
        concurrent(alarms.tick(), alarms.tick()),
        clock.advanceBy(99),
        alarms.tick(),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toMatchObject({ deliveries: 0, alarm: 1_100 });
        }),
        clock.advanceBy(1),
        concurrent(alarms.tick(), alarms.tick()),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toMatchObject({
            message: "hello from main",
            deliveries: 1,
            memoryDeliveries: 1,
            alarm: null,
            servedByThread: queueThread,
            processedByThread: queueThread,
          });
        }),
        background.drain(),
        then(
          "RPC sees alarm waitUntil work and initialized synchronous methods",
          async ({ objects }) => {
            assert.equal(await objects.QUEUE.get("v1:org:org-1").completedBackgroundWork(), true);
            expect(await objects.QUEUE.get("v1:org:org-1").initialized()).toEqual({
              initialized: true,
              threadId: queueThread,
            });
          },
        ),
        concurrent(alarms.tick(), alarms.tick()),
        server.fetch(request("/state?name=org-2"), async (response) => {
          const body = (await response.json()) as { servedByThread: number };
          objectThreads.add(body.servedByThread);
          expect(body).toMatchObject({
            message: "isolated object",
            deliveries: 0,
            memoryDeliveries: 0,
            alarm: null,
          });
          assert.equal(objectThreads.size, 3);
        }),
      ],
    }),
  );
  expect(result.journal).toContainEqual({ kind: "alarm", label: "tick object alarms" });
});

test("Cap'n Web serializes values and fetch bodies across threads without sharing references", async () => {
  const input = {
    text: "original",
    createdAt: new Date(0),
    bytes: new Uint8Array([1, 2]),
    count: 42n,
  };
  const originalRequest = request("/echo", {
    method: "POST",
    body: "serialized request",
    headers: { "x-client": "caller" },
  });
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "worker-serialization",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "disabled" },
      objects: { VALUES: values },
      server: ({ objects }) => ({
        async fetch(req) {
          return await objects.VALUES.get("one").fetch(req);
        },
      }),
      steps: ({ then, server }) => [
        then(
          "RPC mutations do not mutate caller arguments or persisted values",
          async ({ objects }) => {
            const result = await objects.VALUES.get("one").exchange(input);
            expect(result).not.toBe(input);
            assert.equal(input.text, "original");
            expect(input.bytes).toEqual(new Uint8Array([1, 2]));
            expect(result).toMatchObject({
              text: "changed inside worker",
              createdAt: new Date(0),
              count: 42n,
            });
            expect(result.bytes).toEqual(new Uint8Array([9, 2]));
            expect(await objects.VALUES.get("one").read()).toEqual(input);
            await expect(
              objects.VALUES.get("one").echoUnknown(new Map([["unsupported", 1]])),
            ).rejects.toThrow("Cannot serialize value: [object Map]");
          },
        ),
        server.fetch(originalRequest, async (response) => {
          assert.equal(response.status, 201);
          assert.equal(response.headers.get("x-worker-response"), "true");
          const body = (await response.json()) as { threadId: number };
          expect(body).toMatchObject({
            url: originalRequest.url,
            method: "POST",
            header: "caller",
            body: "serialized request",
            isMainThread: false,
          });
          assert.notEqual(body.threadId, threadId);
        }),
        server.fetch(request("/stream"), async (response) => {
          assert.equal(response.status, 202);
          assert.notEqual(response.headers.get("x-object-thread"), String(threadId));
          assert.equal(await response.text(), "first second");
        }),
        then(
          "bidirectional callbacks and pipelined capabilities use Cap'n Web RPC",
          async ({ objects }) => {
            let callbackThread = -1;
            const callbackResult = await objects.VALUES.get("one").callback(async (message) => {
              callbackThread = threadId;
              return `received ${message}`;
            });
            assert.equal(callbackThread, threadId);
            expect(callbackResult).toMatch(/^received worker \d+$/);
            using counterPromise = objects.VALUES.get("one").counter();
            assert.equal(await counterPromise.add(2), 2);
            assert.equal(await counterPromise.add(3), 5);
          },
        ),
      ],
    }),
  );
});

test("failed alarms retry and reschedule inside the same serving worker", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "alarm-retry-and-reschedule",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "disabled" },
      objects: { RETRY: retry },
      server: ({ objects }) => ({
        async fetch(req) {
          return await objects.RETRY.get("one").fetch(req);
        },
      }),
      steps: ({ server, when, alarms, clock }) => [
        server.fetch(request("/retry", { method: "POST" }), (response) => {
          assert.equal(response.status, 204);
        }),
        when("alarm tick surfaces the serialized delivery failure", async (ctx) => {
          await expect(ctx.alarms.tick()).rejects.toThrow(
            "NODE_OBJECT_RUNTIME_ALARM_DELIVERY_FAILED",
          );
        }),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({ attempts: 1, memoryAttempts: 1, alarm: 0 });
        }),
        alarms.tick(),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({ attempts: 2, memoryAttempts: 2, alarm: 10 });
        }),
        alarms.tick(),
        clock.advanceBy(10),
        alarms.tick(),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({ attempts: 3, memoryAttempts: 3, alarm: null });
        }),
      ],
    }),
  );
});

test("ordinary classes share private state between synchronous RPC and fetch handlers", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "class-object",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "disabled" },
      objects: { COUNTER: classObject },
      server: ({ objects }) => ({
        async fetch(req) {
          return await objects.COUNTER.get("one").fetch(req);
        },
      }),
      steps: ({ when, server }) => [
        when("increment the private class state through RPC", async ({ objects }) => {
          assert.equal(await objects.COUNTER.get("one").increment(2), 2);
          assert.equal(await objects.COUNTER.get("one").increment(3), 5);
        }),
        server.fetch(request("/counter"), async (response) => {
          const body = (await response.json()) as { threadId: number };
          expect(body).toMatchObject({ count: 5 });
          assert.notEqual(body.threadId, threadId);
        }),
      ],
    }),
  );
});

test.each(["explicit", "using"] as const)(
  "namespace callers can dispose a stub without invalidating a fresh get (%s disposal)",
  async (disposal) => {
    await runNodeRuntimeScenario(
      defineNodeRuntimeScenario({
        name: `namespace-stub-ownership-${disposal}`,
        storage: environment.createStorage(),
        initialTimeEpochMs: 0,
        objectEviction: { kind: "disabled" },
        objects: { COUNTER: classObject },
        server: ({ objects }) => ({
          async fetch(req) {
            return await objects.COUNTER.get("one").fetch(req);
          },
        }),
        steps: ({ when, then, server }) => [
          when("the first caller increments and disposes its handle", async ({ objects }) => {
            using retained = objects.COUNTER.get("one");
            if (disposal === "explicit") {
              const object = objects.COUNTER.get("one");
              assert.equal(await object.increment(2), 2);
              object[Symbol.dispose]();
            } else {
              using object = objects.COUNTER.get("one");
              assert.equal(await object.increment(2), 2);
            }
            assert.equal(await retained.increment(1), 3);
          }),
          then("a fresh caller can still use the same counter worker", async ({ objects }) => {
            using object = objects.COUNTER.get("one");
            assert.equal(await object.increment(3), 6);
          }),
          server.fetch(request("/counter"), async (response) => {
            expect(await response.json()).toMatchObject({ count: 6 });
          }),
        ],
      }),
    );
  },
);

test("scenario failures identify the step and preserve serialized RPC error causes", async () => {
  const scenario = defineNodeRuntimeScenario({
    name: "rpc-failure",
    storage: environment.createStorage(),
    initialTimeEpochMs: 0,
    objectEviction: { kind: "disabled" },
    objects: { FAILING: failing },
    server: ({ objects }) => ({
      async fetch() {
        await objects.FAILING.get("one").fail();
        return new Response(null);
      },
    }),
    steps: ({ server }) => [
      server.fetch(request("/fail"), () => {
        throw new Error("Response must not be reached");
      }),
    ],
  });
  await expect(runNodeRuntimeScenario(scenario)).rejects.toMatchObject({
    message: "NODE_RUNTIME_SCENARIO_STEP_FAILED:rpc-failure:GET https://node-scenario.test/fail",
    cause: {
      name: "TypeError",
      message: "EXPECTED_SCENARIO_RPC_FAILURE",
      cause: { message: "EXPECTED_RPC_CAUSE" },
    },
  });
});
