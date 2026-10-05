import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type { createBackgroundObject } from "../testing/fixtures/node-runtime-scenario.objects";

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

test("an active returned capability permits concurrent handlers but prevents idle eviction", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "returned-capability-activation-lifetime",
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
        when("sweep during a capability call and after its completed idle window", async (ctx) => {
          using object = ctx.objects.BACKGROUND.get("one");
          const response = await object.fetch(new Request("https://scenario.test/state"));
          const initial = (await response.json()) as { threadId: number };
          using capability = await object.operationCapability();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const deadline = Promise.withResolvers<never>();
          const operation = Promise.resolve(
            capability.completeOperation(async () => {
              entered.resolve();
              await release.promise;
            }),
          );
          // A regression that serializes handlers must fail and release the blocked capability,
          // rather than leave scenario cleanup waiting for it forever.
          const timeout = setTimeout(() => {
            deadline.reject(new Error("CAPABILITY_SCENARIO_CONCURRENT_HANDLER_TIMED_OUT"));
          }, 5_000);
          const observation = (async () => {
            await Promise.race([entered.promise, operation]);
            ctx.clock.advanceBy(1_000);
            await ctx.activations.sweepIdle();
            const pending = await ctx.server.fetch(new Request("https://scenario.test/state"));
            expect(await pending.json()).toMatchObject({
              threadId: initial.threadId,
              capabilityOperationFinished: false,
            });
          })();
          try {
            await Promise.race([observation, deadline.promise]);
          } finally {
            clearTimeout(timeout);
            release.resolve();
            await Promise.allSettled([operation, observation]);
          }
          await operation;
          ctx.clock.advanceBy(1_000);
          await ctx.activations.sweepIdle();
          await expect(capability.completeOperation(async () => {})).rejects.toThrow(
            "NODE_OBJECT_RUNTIME_OBJECT_EVICTED",
          );
          const restoredResponse = await ctx.server.fetch(
            new Request("https://scenario.test/state"),
          );
          const restored = (await restoredResponse.json()) as {
            threadId: number;
            capabilityOperationFinished: boolean;
          };
          assert.notEqual(restored.threadId, initial.threadId);
          assert.equal(restored.capabilityOperationFinished, true);
        }),
      ],
    }),
  );
}, 15_000);
