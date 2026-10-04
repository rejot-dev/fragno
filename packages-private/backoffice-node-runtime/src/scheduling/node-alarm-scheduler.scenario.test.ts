import { afterAll, beforeAll, expect, test } from "vitest";

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

const moduleUrl = new URL("../testing/fixtures/node-runtime-scenario.objects.ts", import.meta.url);
const queue = defineNodeRuntimeObject<typeof createQueueObject>(moduleUrl, "createQueueObject");
const background = defineNodeRuntimeObject<typeof createBackgroundObject>(
  moduleUrl,
  "createBackgroundObject",
);

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("a pending waitUntil in one object does not delay another object's due alarm", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "alarm-delivery-isolated-from-unrelated-background-work",
      storage: environment.createStorage(),
      initialTimeEpochMs: 0,
      objectEviction: { kind: "disabled" },
      objects: { QUEUE: queue, BACKGROUND: background },
      server: ({ objects }) => ({
        async fetch(request) {
          return await objects.QUEUE.get("one").fetch(request);
        },
      }),
      steps: ({ when }) => [
        when("poll alarms while a different worker's background task is held open", async (ctx) => {
          const backgroundEntered = Promise.withResolvers<void>();
          const releaseBackground = Promise.withResolvers<void>();
          using backgroundObject = ctx.objects.BACKGROUND.get("busy");
          using alarmObject = ctx.objects.QUEUE.get("one");
          let alarmTick: Promise<void> | null = null;
          try {
            await backgroundObject.startBlockedBackground(async () => {
              backgroundEntered.resolve();
              await releaseBackground.promise;
            });
            await backgroundEntered.promise;
            await alarmObject.schedule("independent alarm", 0);

            alarmTick = ctx.alarms.tick();
            // Observe a poll failure immediately even while the assertion waits for durable state.
            void alarmTick.catch(() => {});
            await expect
              .poll(
                async () => {
                  const response = await alarmObject.fetch(
                    new Request("https://scenario.test/state"),
                  );
                  return await response.json();
                },
                {
                  timeout: 1_000,
                  message: "The alarm must finish before the unrelated waitUntil is released",
                },
              )
              .toMatchObject({ message: "independent alarm", deliveries: 1, alarm: null });
          } finally {
            releaseBackground.resolve();
            await alarmTick;
          }
          await expect
            .poll(
              async () => {
                const response = await backgroundObject.fetch(
                  new Request("https://scenario.test/state"),
                );
                return await response.json();
              },
              { timeout: 1_000 },
            )
            .toMatchObject({ backgroundFinished: true });
        }),
      ],
    }),
  );
});
