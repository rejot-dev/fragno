import { assert, expect, test } from "vitest";

import {
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
  type NodeRuntimeScenarioObjectContext,
} from "./node-runtime-scenario";

function createQueueObject({ state, runtimeName, nowEpochMs }: NodeRuntimeScenarioObjectContext) {
  void state.blockConcurrencyWhile(async () => {
    if ((await state.storage.get("initialized")) === undefined) {
      await state.storage.put("initialized", true);
    }
  });

  return {
    async schedule(message: string, delayMs: number) {
      await state.storage.put("message", message);
      await state.storage.setAlarm(nowEpochMs() + delayMs);
      return { scheduled: true, runtimeName };
    },
    async fetch(request: Request) {
      if (request.method === "POST") {
        await state.storage.put("message", await request.text());
        return new Response(null, { status: 204 });
      }
      return Response.json({
        message: (await state.storage.get("message")) ?? null,
        initialized: await state.storage.get("initialized"),
        deliveries: (await state.storage.get("deliveries")) ?? 0,
        processedBy: (await state.storage.get("processedBy")) ?? null,
        alarm: await state.storage.getAlarm(),
        servedBy: runtimeName,
      });
    },
    async alarm() {
      await state.storage.put(
        "deliveries",
        ((await state.storage.get<number>("deliveries")) ?? 0) + 1,
      );
      await state.storage.put("processedBy", runtimeName);
      state.waitUntil(state.storage.put("completedBackgroundWork", true));
    },
    async completedBackgroundWork() {
      return (await state.storage.get("completedBackgroundWork")) ?? false;
    },
  };
}

function createReceiptObject({ state }: NodeRuntimeScenarioObjectContext) {
  return {
    async record(message: string) {
      await state.storage.put("receipt", message);
    },
    async fetch(_request: Request) {
      return Response.json({ receipt: (await state.storage.get("receipt")) ?? null });
    },
  };
}

function request(pathname: string, init: RequestInit = {}): Request {
  return new Request(`https://node-scenario.test${pathname}`, init);
}

test("main server calls object fetch and RPC while independent processors compete for due alarms", async () => {
  const scenario = defineNodeRuntimeScenario({
    name: "main-server-and-competing-processors",
    initialTimeEpochMs: 1_000,
    objects: { QUEUE: createQueueObject, RECEIPT: createReceiptObject },
    processors: ["first", "second"],
    server: ({ objects }) => ({
      async fetch(req) {
        const url = new URL(req.url);
        const objectName = url.searchParams.get("name") ?? "v1:org:org-1";
        if (url.pathname === "/schedule") {
          const message = await req.text();
          const result = await objects.QUEUE.get(objectName).schedule(message, 100);
          await objects.RECEIPT.get(objectName).record(message);
          return Response.json(result);
        }
        if (url.pathname === "/receipt") {
          return await objects.RECEIPT.get(objectName).fetch(req);
        }
        return await objects.QUEUE.get(objectName).fetch(req);
      },
    }),
    steps: ({ server, then, processors, clock, concurrent }) => [
      server.fetch(
        request("/schedule", { method: "POST", body: "hello from main" }),
        async (response) => {
          expect(await response.json()).toEqual({ scheduled: true, runtimeName: "main" });
        },
      ),
      server.fetch(request("/state"), async (response) => {
        expect(await response.json()).toEqual({
          message: "hello from main",
          initialized: true,
          deliveries: 0,
          processedBy: null,
          alarm: 1_100,
          servedBy: "main",
        });
      }),
      server.fetch(request("/receipt"), async (response) => {
        expect(await response.json()).toEqual({ receipt: "hello from main" });
      }),
      server.fetch(
        request("/state?name=org-2", { method: "POST", body: "isolated object" }),
        (response) => {
          assert.equal(response.status, 204);
        },
      ),
      concurrent(processors.first.tick(), processors.second.tick()),
      clock.advanceBy(99),
      processors.first.tick(),
      server.fetch(request("/state"), async (response) => {
        expect(await response.json()).toMatchObject({ deliveries: 0, alarm: 1_100 });
      }),
      clock.advanceBy(1),
      concurrent(processors.first.tick(), processors.second.tick()),
      server.fetch(request("/state"), async (response) => {
        const body = (await response.json()) as { processedBy: string };
        expect(body).toMatchObject({
          message: "hello from main",
          deliveries: 1,
          alarm: null,
          servedBy: "main",
        });
        expect(["first", "second"]).toContain(body.processedBy);
      }),
      then("processor waitUntil work is visible to main via RPC", async ({ objects }) => {
        assert.equal(await objects.QUEUE.get("v1:org:org-1").completedBackgroundWork(), true);
      }),
      concurrent(processors.first.tick(), processors.second.tick()),
      server.fetch(request("/state"), async (response) => {
        expect(await response.json()).toMatchObject({ deliveries: 1, alarm: null });
      }),
      server.fetch(request("/state?name=org-2"), async (response) => {
        expect(await response.json()).toMatchObject({
          message: "isolated object",
          deliveries: 0,
          alarm: null,
        });
      }),
    ],
  });

  await runNodeRuntimeScenario(scenario);
});

test("local fetch and RPC use direct calls while SQLite storage serializes values", async () => {
  const input = { text: "original", createdAt: new Date(0) };
  const originalRequest = request("/forward");
  const originalResponse = new Response("direct response");
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "direct-calls-versus-persistence",
      initialTimeEpochMs: 0,
      processors: ["worker"],
      objects: {
        VALUES: ({ state }) => ({
          async exchange(value: typeof input) {
            await state.storage.put("value", value);
            value.text = "changed through RPC";
            return value;
          },
          async read() {
            return await state.storage.get<typeof input>("value");
          },
          async fetch(req: Request) {
            expect(req).toBe(originalRequest);
            return originalResponse;
          },
        }),
      },
      server: ({ objects }) => ({
        async fetch(req) {
          if (new URL(req.url).pathname === "/exchange") {
            const result = await objects.VALUES.get("one").exchange(input);
            assert.strictEqual(result, input);
            return new Response(null, { status: 204 });
          }
          return await objects.VALUES.get("one").fetch(req);
        },
      }),
      steps: ({ then, server }) => [
        server.fetch(request("/exchange"), (response) => {
          assert.equal(response.status, 204);
          assert.equal(input.text, "changed through RPC");
        }),
        then(
          "persisted values are isolated copies with native Date support",
          async ({ objects }) => {
            const stored = await objects.VALUES.get("one").read();
            expect(stored).toEqual({ text: "original", createdAt: new Date(0) });
            expect(stored).not.toBe(input);
          },
        ),
        server.fetch(originalRequest, (response) => {
          assert.strictEqual(response, originalResponse);
        }),
      ],
    }),
  );
});

test("failed alarms remain scheduled, retry on the next tick, and can reschedule themselves", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "alarm-retry-and-reschedule",
      initialTimeEpochMs: 0,
      processors: ["worker"],
      objects: {
        RETRY: ({ state, nowEpochMs }) => ({
          async fetch(req: Request) {
            if (req.method === "POST") {
              await state.storage.setAlarm(nowEpochMs());
              return new Response(null, { status: 204 });
            }
            return Response.json({
              attempts: (await state.storage.get("attempts")) ?? 0,
              alarm: await state.storage.getAlarm(),
            });
          },
          async alarm() {
            const attempts = ((await state.storage.get<number>("attempts")) ?? 0) + 1;
            await state.storage.put("attempts", attempts);
            if (attempts === 1) {
              throw new Error("EXPECTED_SCENARIO_ALARM_FAILURE");
            }
            if (attempts === 2) {
              await state.storage.setAlarm(nowEpochMs() + 10);
            }
          },
        }),
      },
      server: ({ objects }) => ({
        async fetch(req) {
          return await objects.RETRY.get("one").fetch(req);
        },
      }),
      steps: ({ server, when, processors, clock }) => [
        server.fetch(request("/retry", { method: "POST" }), (response) => {
          assert.equal(response.status, 204);
        }),
        when("processor surfaces the failed delivery", async (ctx) => {
          await expect(ctx.processors.worker.tick()).rejects.toThrow(
            "One or more Node Backoffice alarm drain stages failed.",
          );
        }),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({ attempts: 1, alarm: 0 });
        }),
        processors.worker.tick(),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({ attempts: 2, alarm: 10 });
        }),
        processors.worker.tick(),
        clock.advanceBy(10),
        processors.worker.tick(),
        server.fetch(request("/state"), async (response) => {
          expect(await response.json()).toEqual({ attempts: 3, alarm: null });
        }),
      ],
    }),
  );
});

test("scenario failures identify the step and preserve the original cause", async () => {
  const failure = new Error("EXPECTED_SCENARIO_RPC_FAILURE");
  const scenario = defineNodeRuntimeScenario({
    name: "rpc-failure",
    initialTimeEpochMs: 0,
    processors: ["worker"],
    objects: {
      FAILING: () => ({
        async fetch() {
          return new Response(null);
        },
        async fail() {
          throw failure;
        },
      }),
    },
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
    cause: failure,
  });
});
