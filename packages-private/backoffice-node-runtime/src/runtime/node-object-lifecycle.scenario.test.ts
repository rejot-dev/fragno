import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type {
  createLifecycleObject,
  createFailingLifecycleObject,
} from "../testing/fixtures/node-lifecycle.objects";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});
const lifecycle = defineNodeRuntimeObject<typeof createLifecycleObject>(
  new URL("../testing/fixtures/node-lifecycle.objects.ts", import.meta.url),
  "createLifecycleObject",
);

test("worker-local cleanup runs before SQLite closes and is durable across eviction and shutdown", async () => {
  const definition = {
    storage: environment.createStorage(),
    objects: { LIFECYCLE: lifecycle },
    initialTimeEpochMs: 0,
    objectEviction: { kind: "manual", idleTimeoutMs: 1 } as const,
    server: ({
      objects,
    }: {
      objects: { LIFECYCLE: { get(name: string): { fetch(request: Request): Promise<Response> } } };
    }) => ({
      fetch: async (request: Request) => await objects.LIFECYCLE.get("one").fetch(request),
    }),
  };
  let firstThread: number;
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "application cleanup during idle eviction",
      steps: ({ server, clock, activations }) => [
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          const state = (await response.json()) as {
            threadId: number;
            closed: number;
            cleanupThreads: number[];
          };
          firstThread = state.threadId;
          expect(state).toMatchObject({ closed: 0, cleanupThreads: [] });
        }),
        clock.advanceBy(10),
        activations.sweepIdle(),
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          const state = (await response.json()) as {
            threadId: number;
            closed: number;
            cleanupThreads: number[];
          };
          expect(state.threadId).not.toBe(firstThread);
          expect(state).toMatchObject({ closed: 1, cleanupThreads: [firstThread] });
        }),
      ],
    }),
  );
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "application cleanup during process shutdown",
      steps: ({ server }) => [
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          expect(await response.json()).toMatchObject({
            closed: 2,
            cleanupThreads: expect.arrayContaining([firstThread]),
          });
        }),
      ],
    }),
  );
});

test("failed initialization closes worker-local resources before the activation is discarded", async () => {
  const storage = environment.createStorage();
  const cleanupPath = path.join(path.dirname(storage.configPath), "initialization-cleanup.txt");
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "application cleanup after failed initialization",
      storage,
      objectEviction: { kind: "disabled" },
      objects: {
        LIFECYCLE: defineNodeRuntimeObject<typeof createFailingLifecycleObject>(
          new URL("../testing/fixtures/node-lifecycle.objects.ts", import.meta.url),
          "createFailingLifecycleObject",
          { cleanupPath },
        ),
      },
      initialTimeEpochMs: 0,
      server: ({ objects }) => ({
        async fetch(request: Request) {
          using object = objects.LIFECYCLE.get("one");
          return await object.fetch(request);
        },
      }),
      steps: ({ when, then }) => [
        when("initialization fails", async ({ server }) => {
          await expect(server.fetch(new Request("https://scenario.test/"))).rejects.toThrow(
            "NODE_LIFECYCLE_INITIALIZATION_FAILED",
          );
        }),
        then("the application resource was closed", async () => {
          assert((await readFile(cleanupPath, "utf8")) === "closed");
        }),
      ],
    }),
  );
});
