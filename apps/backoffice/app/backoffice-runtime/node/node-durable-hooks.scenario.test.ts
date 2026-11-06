import { expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { UploadObject } from "../../../workers/upload-object";
import {
  createExternallyProcessedNodeBackofficeDurableHooks,
  createNodeBackofficeDurableHooks,
} from "./node-durable-hooks";

const scenarioObjects = {
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const localObjects = {
  AUTOMATIONS: (input) => new AutomationsObject(input),
} satisfies LocalBackofficeObjects;

async function getAutomationsHookQueue(runtime: InMemoryBackofficeRuntime) {
  return await runtime.objects.automations
    .singleton()
    .commands.getDurableHookQueue("automation", { pageSize: 100 });
}

async function waitForCompletedIngestHook(runtime: InMemoryBackofficeRuntime) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const queue = await getAutomationsHookQueue(runtime);
    if (
      queue.items.some(
        (hook) => hook.hookName === "internalIngestEvent" && hook.status === "completed",
      )
    ) {
      return queue;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Node Backoffice durable hooks did not complete before the scenario deadline.");
}

test("a separate Node processor completes hooks recorded by the server runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-hooks-scenario-"));
  const processorErrors: unknown[] = [];
  const processorHooks = createNodeBackofficeDurableHooks({
    pollIntervalMs: 20,
    onError(error) {
      processorErrors.push(error);
    },
  });
  const processorRuntime = await createInMemoryBackofficeRuntime({
    objects: localObjects,
    sqliteDataDirectory: directory,
    durableHooks: processorHooks,
  });

  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a separate Node processor completes hooks recorded by the server runtime",
        durableHooks: createExternallyProcessedNodeBackofficeDurableHooks(),
        options: { drain: false, sqliteDataDirectory: directory },
        steps: ({ then }) => [
          then.assert("the server commits an event hook for external processing", async (ctx) => {
            await ctx.runtime.objects.automations.singleton().commands.ingestEvent({
              id: "externally-processed-event",
              scopeRestriction: null,
              scope: { kind: "system" },
              source: "custom",
              eventType: "thing.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: {},
              actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
              subject: null,
              causation: { kind: "origin" },
            });

            const queue = await getAutomationsHookQueue(ctx.runtime);
            expect(queue.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ hookName: "internalIngestEvent", status: "pending" }),
              ]),
            );
          }),
          then.assert("the processor discovers the object and completes its hook", async (ctx) => {
            await processorRuntime.discoverPersistedObjects();
            const queue = await waitForCompletedIngestHook(ctx.runtime);
            expect(queue.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ hookName: "internalIngestEvent", status: "completed" }),
              ]),
            );
            expect(processorErrors).toEqual([]);
          }),
        ],
      }),
    );
  } finally {
    await processorRuntime.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
