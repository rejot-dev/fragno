import { assert, expect, test, vi } from "vitest";

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
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import {
  createExternallyProcessedNodeBackofficeDurableHooks,
  createNodeBackofficeDurableHooks,
} from "./node-durable-hooks";

async function getFormsHookQueue(runtime: InMemoryBackofficeRuntime) {
  return await runtime.objects.forms.singleton().commands.getDurableHookQueue({ pageSize: 100 });
}

async function waitForCompletedFormsHooks(runtime: InMemoryBackofficeRuntime) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const queue = await getFormsHookQueue(runtime);
    if (
      queue.items.some((hook) => hook.hookName === "onFormCreated" && hook.status === "completed")
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
    sqliteDataDirectory: directory,
    durableHooks: processorHooks,
  });

  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "a separate Node processor completes hooks recorded by the server runtime",
        durableHooks: createExternallyProcessedNodeBackofficeDurableHooks(),
        options: { drain: false, sqliteDataDirectory: directory },
        steps: ({ then }) => [
          then.assert("the server commits a form hook for external processing", async (ctx) => {
            const response = await ctx.runtime.objects.forms.singleton().http.fetch(
              new Request("https://forms.test/api/forms/admin/forms", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  title: "Externally processed form",
                  slug: "externally-processed-form",
                  description: null,
                  status: "draft",
                  dataSchema: { type: "object" },
                }),
              }),
            );
            assert(response.ok);

            const queue = await getFormsHookQueue(ctx.runtime);
            expect(queue.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ hookName: "onFormCreated", status: "pending" }),
              ]),
            );
          }),
          then.assert("the processor discovers the object and completes its hook", async (ctx) => {
            await processorRuntime.discoverPersistedObjects();
            const queue = await waitForCompletedFormsHooks(ctx.runtime);
            expect(queue.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ hookName: "onFormCreated", status: "completed" }),
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
