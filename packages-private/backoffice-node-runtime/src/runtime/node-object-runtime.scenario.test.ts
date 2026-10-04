import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type {
  createBackgroundObject,
  createQueueObject,
} from "../testing/fixtures/node-runtime-scenario.objects";

const queue = defineNodeRuntimeObject<typeof createQueueObject>(
  new URL("../testing/fixtures/node-runtime-scenario.objects.ts", import.meta.url),
  "createQueueObject",
);

const background = defineNodeRuntimeObject<typeof createBackgroundObject>(
  new URL("../testing/fixtures/node-runtime-scenario.objects.ts", import.meta.url),
  "createBackgroundObject",
);

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("alarm polling does not keep an idle Graft object activation resident", async () => {
  let originalThreadId = 0;
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "idle-eviction-with-alarm-polling",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "manual", idleTimeoutMs: 1_000 },
      objects: { QUEUE: queue },
      server: ({ objects }) => ({
        async fetch(request) {
          return await objects.QUEUE.get("one").fetch(request);
        },
      }),
      steps: ({ given, clock, alarms, background, activations, server }) => [
        given("an object with durable data and an alarm that is not due", async ({ objects }) => {
          using object = objects.QUEUE.get("one");
          const scheduled = await object.schedule("survives idle eviction", 10_000);
          originalThreadId = scheduled.threadId;
        }),
        clock.advanceBy(500),
        alarms.tick(),
        background.drain(),
        activations.sweepIdle(),
        clock.advanceBy(500),
        alarms.tick(),
        background.drain(),
        activations.sweepIdle(),
        server.fetch(new Request("https://scenario.test/state"), async (response) => {
          const state = (await response.json()) as {
            servedByThread: number;
            message: string;
            alarm: number | null;
          };
          expect(state).toMatchObject({ message: "survives idle eviction", alarm: 10_000 });
          assert.notEqual(
            state.servedByThread,
            originalThreadId,
            "Empty alarm polls must not refresh the activation's idle deadline",
          );
        }),
      ],
    }),
  );
});

test("automatic idle eviction reports a fenced authority without escaping its timer", async () => {
  const reported = Promise.withResolvers<unknown>();
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "automatic-eviction-after-authority-fencing",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: {
        kind: "automatic",
        idleTimeoutMs: 1_000,
        sweepIntervalMs: 10,
        reportError(error) {
          reported.resolve(error);
        },
      },
      objects: { QUEUE: queue },
      server: () => ({
        fetch() {
          return Promise.resolve(Response.json({ ready: true }));
        },
      }),
      steps: ({ clock, when }) => [
        clock.advanceBy(60_001),
        when("the background sweep preserves fencing and reports its error", async (context) => {
          const error = await reported.promise;
          expect(error).toBeInstanceOf(Error);
          assert.equal((error as Error).message, "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
          await expect(
            context.server.fetch(new Request("https://scenario.test/state")),
          ).rejects.toThrow("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
        }),
      ],
    }),
  );
});

test("pending waitUntil prevents idle eviction and its completion starts a fresh idle window", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "idle-eviction-after-background-completion",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "manual", idleTimeoutMs: 1_000 },
      objects: { BACKGROUND: background },
      server: ({ objects }) => ({
        async fetch(request) {
          return await objects.BACKGROUND.get("one").fetch(request);
        },
      }),
      steps: ({ when }) => [
        when("sweep before and after registered background work completes", async (ctx) => {
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          using object = ctx.objects.BACKGROUND.get("one");
          const initialResponse = await object.fetch(new Request("https://scenario.test/state"));
          const initial = (await initialResponse.json()) as { threadId: number };
          try {
            await object.startBlockedBackground(async () => {
              entered.resolve();
              await release.promise;
            });
            await entered.promise;
            ctx.clock.advanceBy(2_000);
            await ctx.activations.sweepIdle();
            const pendingResponse = await ctx.server.fetch(
              new Request("https://scenario.test/state"),
            );
            expect(await pendingResponse.json()).toMatchObject({
              threadId: initial.threadId,
              backgroundFinished: false,
            });

            ctx.clock.advanceBy(2_000);
            release.resolve();
            await ctx.background.drain();
            ctx.clock.advanceBy(999);
            await ctx.activations.sweepIdle();
            const completedResponse = await ctx.server.fetch(
              new Request("https://scenario.test/state"),
            );
            expect(await completedResponse.json()).toMatchObject({
              threadId: initial.threadId,
              backgroundFinished: true,
            });

            ctx.clock.advanceBy(1_000);
            await ctx.activations.sweepIdle();
            const restoredResponse = await ctx.server.fetch(
              new Request("https://scenario.test/state"),
            );
            const restored = (await restoredResponse.json()) as {
              threadId: number;
              backgroundFinished: boolean;
            };
            assert.notEqual(restored.threadId, initial.threadId);
            assert.equal(restored.backgroundFinished, true);
          } finally {
            release.resolve();
          }
        }),
      ],
    }),
  );
});
