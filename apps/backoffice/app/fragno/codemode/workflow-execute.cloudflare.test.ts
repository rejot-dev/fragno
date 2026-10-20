import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test, assert } from "vitest";

import { schema } from "@fragno-dev/db/schema";
import type { RemoteWorkflowAllowedHook } from "@fragno-dev/workflows/remote-workflow";
import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import {
  defineRemoteWorkflow,
  defineWorkflow,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { getDurableHooksService, withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { codemodeRunnerFor, type CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import {
  createTrustedSystemBackofficeToolContext,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
} from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { defineCodemodeWorkflowRun, runBackofficeCodemodeWorkflow } from "./workflow-execute";

const codemode = codemodeRunnerFor(
  createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
  createBackofficeSystemExecution({ kind: "system" }),
);

/** Runs a test body with a Codemode runner created where its workflow runner lives. */
async function runInWorkflowRunner(
  runner: "test worker" | "Durable Object",
  body: (codemode: CodemodeRunner) => Promise<void>,
) {
  const createRunner = () =>
    codemodeRunnerFor(
      createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
      createBackofficeSystemExecution({ kind: "system" }),
    );
  if (runner === "test worker") {
    await body(createRunner());
    return;
  }
  const namespace = (env as typeof env & { WORKFLOWS_HARNESS: DurableObjectNamespace })
    .WORKFLOWS_HARNESS;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async () => {
    await body(createRunner());
  });
}

const createHarness = async <TRegistry extends WorkflowsRegistry>(workflows: TRegistry) =>
  await createWorkflowsTestHarness({
    workflows,
    adapter: { type: "in-memory" },
    testBuilder: buildDatabaseFragmentsTest(),
    autoTickHooks: false,
  });

const createSystemWorkflowOptions = () => ({
  allowedHooks: [],
  origin: { kind: "inline" } as const,
  families: runtimeToolFamilies,
  toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
  modules: {},
});

describe("codemode workflow execution", () => {
  test("checkpoints nested steps without repeating committed effects across runner restarts", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-checkpointed", checkpoint: "step" },
      defineCodemodeWorkflowRun<undefined, number>(
        `async (_event, step) => {
          const first = await step.do("first", async (tx) => {
            tx.emit({ phase: "checkpoint-effect" });
            return 1;
          });
          const second = await step.do("second", async () =>
            await step.do("first", async () => first + 1));
          return await step.do("third", async () => second + 1);
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    try {
      const instanceId = await harness.createInstance("WORKFLOW", {
        id: "codemode-checkpointed-1",
        remoteWorkflowName: "codemode-checkpointed-body",
      });

      await harness.tick({
        workflowName: "codemode-checkpointed",
        instanceId,
        reason: "create",
      });
      expect((await harness.getHistory("WORKFLOW", instanceId)).steps).toMatchObject([
        { stepKey: "do:first", status: "completed", result: 1 },
      ]);

      await harness.restart();
      await harness.tick({
        workflowName: "codemode-checkpointed",
        instanceId,
        reason: "wake",
      });
      expect((await harness.getHistory("WORKFLOW", instanceId)).steps).toMatchObject([
        { stepKey: "do:first", status: "completed", result: 1 },
        { stepKey: "do:second", status: "completed", result: 2 },
        { stepKey: "do:second>do:first", parentStepKey: "do:second", depth: 1, result: 2 },
      ]);

      await harness.restart();
      await harness.tick({
        workflowName: "codemode-checkpointed",
        instanceId,
        reason: "wake",
      });
      await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
        status: "complete",
        output: 3,
      });
      const history = await harness.getHistory("WORKFLOW", instanceId);
      expect(history.steps.map((step) => step.stepKey)).toEqual([
        "do:first",
        "do:second",
        "do:second>do:first",
        "do:third",
      ]);
      expect(history.emissions.filter((emission) => emission.actor === "user")).toEqual([
        expect.objectContaining({ stepKey: "do:first", payload: { phase: "checkpoint-effect" } }),
      ]);
    } finally {
      await harness.test.cleanup();
    }
  });

  test("runs a workflow end-to-end in a dynamic worker with real runner steps", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-complete" },
      defineCodemodeWorkflowRun<{ value: number }, { nested: number }>(
        `async (event, step) => {
          const seed = await step.do("seed", async (tx) => {
            tx.emit({ phase: "seeded", value: event.payload.value });
            return event.payload.value;
          });

          const nested = await step.do("outer", async () => {
            return await step.do("inner", async () => seed + 1);
          });

          return { nested };
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-complete-1",
      remoteWorkflowName: "codemode-e2e-complete-body",
      params: { value: 41 },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-complete",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: { nested: 42 },
    });

    const history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps.map((step) => step.stepKey)).toEqual([
      "do:seed",
      "do:outer",
      "do:outer>do:inner",
    ]);
    expect(history.steps.find((step) => step.stepKey === "do:outer>do:inner")).toMatchObject({
      parentStepKey: "do:outer",
      depth: 1,
      status: "completed",
      result: 42,
    });
    expect(history.emissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "user",
          stepKey: "do:seed",
          payload: { phase: "seeded", value: 41 },
        }),
      ]),
    );
  });

  test("runs a defineWorkflow codemode script end-to-end", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-define-workflow" },
      defineCodemodeWorkflowRun<{ value: number }, { value: number; doubled: number }>(
        `defineWorkflow({ name: "script-local-name" }, async (event, step) => {
          const value = await step.do("compute", async () => event.payload.value + 1);
          const doubled = await step.do("double", async () => value * 2);
          return { value, doubled };
        });`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-define-workflow-1",
      remoteWorkflowName: "script-local-name",
      params: { value: 41 },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-define-workflow",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: { value: 42, doubled: 84 },
    });
    const history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: "do:compute",
          status: "completed",
          result: 42,
        }),
        expect.objectContaining({
          stepKey: "do:double",
          status: "completed",
          result: 84,
        }),
      ]),
    );
  });

  test("workflow codemode seals outbound fetch by default", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-fetch-sealed" },
      defineCodemodeWorkflowRun(
        `async (_event, step) => {
          return await step.do("fetch", async () => {
            const res = await fetch("https://example.com/dolphins");
            return await res.text();
          });
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-fetch-sealed-1",
      remoteWorkflowName: "codemode-e2e-fetch-sealed-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-fetch-sealed",
      instanceId,
      reason: "create",
    });

    const status = await harness.getStatus("WORKFLOW", instanceId);
    assert(status.status === "errored");
    expect((status as { error?: { message?: string } }).error?.message).toContain(
      "not permitted to access the internet",
    );
  });

  test("runBackofficeCodemodeWorkflow preserves step suspension for wrapper callers", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-wrapper-sleep" },
      async (event, remote) => {
        const result = await runBackofficeCodemodeWorkflow({
          code: `async (_event, step) => {
          await step.sleep("pause", "3 seconds");
          return "done";
        }`,
          event,
          remote,
          codemode,
          allowedHooks: [],
          origin: { kind: "inline" } as const,
          modules: {},
          families: runtimeToolFamilies,
          toolContext: createTrustedSystemBackofficeToolContext({
            runtimes: {},
          }),
        });
        if (result.error) {
          throw new Error(result.error);
        }
        return result.result;
      },
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-wrapper-sleep-1",
      remoteWorkflowName: "codemode-wrapper-sleep-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-wrapper-sleep",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "waiting",
    });

    harness.clock.advanceBy("3 seconds");
    await harness.runUntilIdle({
      workflowName: "codemode-wrapper-sleep",
      instanceId,
      reason: "wake",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: "done",
    });
  });

  test("remote sleep suspends until the wake delay has elapsed", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-sleep" },
      defineCodemodeWorkflowRun<unknown, string>(
        `async (_event, step) => {
          await step.sleep("pause", "3 seconds");
          return await step.do("after-sleep", async () => "done");
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-sleep-1",
      remoteWorkflowName: "codemode-e2e-sleep-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-sleep",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "waiting",
    });
    let history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepKey: "sleep:pause", status: "waiting" }),
      ]),
    );
    assert(!history.steps.some((step) => step.stepKey === "do:after-sleep"));

    harness.clock.advanceBy("3 seconds");
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-sleep",
      instanceId,
      reason: "wake",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: "done",
    });
    history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: "sleep:pause",
          status: "completed",
        }),
        expect.objectContaining({
          stepKey: "do:after-sleep",
          status: "completed",
        }),
      ]),
    );
  });

  test("exposes previous step emissions as an async remote tx method", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-previous-emissions" },
      defineCodemodeWorkflowRun<unknown, unknown[]>(
        `async (_event, step) => {
          return await step.do(
            "recover",
            { retries: { limit: 1, delay: "0 ms" } },
            async (tx) => {
              const previous = await tx.previousEmissions();
              if (previous.length === 0) {
                tx.emit({ phase: "first-attempt" });
                throw new Error("retry me");
              }
              return previous.map((emission) => emission.payload);
            },
          );
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-previous-emissions-1",
      remoteWorkflowName: "codemode-e2e-previous-emissions-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-previous-emissions",
      instanceId,
      reason: "create",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-previous-emissions",
      instanceId,
      reason: "retry",
    });

    const status = await harness.getStatus("WORKFLOW", instanceId);
    expect(status).toMatchObject({ status: "complete" });
    expect(status.output).toEqual(
      expect.arrayContaining([expect.objectContaining({ control: "step-started" })]),
    );
  });

  test("exposes backoffice codemode providers inside workflow code", async () => {
    const calls: unknown[] = [];
    const doubleTool = defineBackofficeRuntimeTool({
      id: "math.twice",
      namespace: "math",
      name: "twice",
      description: "Double a number.",
      requiredPermissions: [],
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      execute: async (input) => {
        calls.push(input);
        return { value: input.value * 2 };
      },
    });
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-providers" },
      defineCodemodeWorkflowRun<{ value: number }, { value: number }>(
        `async (event, step) => {
          return await step.do("tool", async () => {
            return await math.twice({ value: event.payload.value });
          });
        }`,
        codemode,
        {
          allowedHooks: [],
          origin: { kind: "inline" } as const,
          modules: {},
          families: [
            defineBackofficeRuntimeToolFamily({
              namespace: "math",
              tools: [doubleTool],
            }),
          ],
          toolContext: createTrustedSystemBackofficeToolContext({
            runtimes: {},
          }),
        },
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-providers-1",
      remoteWorkflowName: "codemode-e2e-providers-body",
      params: { value: 21 },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-providers",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: { value: 42 },
    });
    expect(calls).toEqual([{ value: 21 }]);
  });

  test("restores workflow progress after the dynamic worker environment is discarded", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-volatile-worker" },
      defineCodemodeWorkflowRun<unknown, { before: number; after: number }>(
        `async (_event, step) => {
          globalThis.__fragnoVolatileWorkerState ??= 0;

          const before = await step.do("before", async () => {
            globalThis.__fragnoVolatileWorkerState += 1;
            return globalThis.__fragnoVolatileWorkerState;
          });

          await step.waitForEvent("continue", { type: "continue" });

          const after = await step.do("after", async () => {
            globalThis.__fragnoVolatileWorkerState += 1;
            return globalThis.__fragnoVolatileWorkerState;
          });

          return { before, after };
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-volatile-worker-1",
      remoteWorkflowName: "codemode-e2e-volatile-worker-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-volatile-worker",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "waiting",
    });
    let history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual([
      expect.objectContaining({
        stepKey: "do:before",
        status: "completed",
        result: 1,
      }),
      expect.objectContaining({
        stepKey: "waitForEvent:continue",
        status: "waiting",
      }),
    ]);

    await harness.sendEvent("WORKFLOW", instanceId, {
      type: "continue",
      payload: {},
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-volatile-worker",
      instanceId,
      reason: "event",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: { before: 1, after: 1 },
    });
    history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: "do:before",
          status: "completed",
          result: 1,
        }),
        expect.objectContaining({
          stepKey: "waitForEvent:continue",
          status: "completed",
        }),
        expect.objectContaining({
          stepKey: "do:after",
          status: "completed",
          result: 1,
        }),
      ]),
    );
  });

  // Production runners are Durable Objects, so step capabilities reach the guest from one too.
  test.each(["test worker", "Durable Object"] as const)(
    "consumes events with Date values intact and resumes after a durable sleep from a %s",
    async (runner) => {
      await runInWorkflowRunner(runner, async (codemode) => {
        const Workflow = defineRemoteWorkflow(
          { name: "codemode-e2e-wait" },
          defineCodemodeWorkflowRun<unknown, { approved: boolean; preservedDate: boolean }>(
            `async (event, step) => {
          const approval = await step.waitForEvent("approval", {
            type: "approval",
            onConsume: async (tx, received) => {
              tx.emit({ timestamp: received.timestamp.toISOString() });
            },
          });
          await step.sleepUntil("cooldown", new Date(event.timestamp.getTime() + 1000));
          return await step.do("save approval", async () => ({
            approved: approval.payload.approved,
            preservedDate: approval.timestamp instanceof Date,
          }));
        }`,
            codemode,
            createSystemWorkflowOptions(),
          ),
        );
        const harness = await createHarness({ WORKFLOW: Workflow });

        try {
          const instanceId = await harness.createInstance("WORKFLOW", {
            id: "codemode-e2e-wait-1",
            remoteWorkflowName: "codemode-e2e-wait-body",
          });
          await harness.runUntilIdle({
            workflowName: "codemode-e2e-wait",
            instanceId,
            reason: "create",
          });

          await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
            status: "waiting",
          });
          expect((await harness.getHistory("WORKFLOW", instanceId)).steps).toEqual([
            expect.objectContaining({
              stepKey: "waitForEvent:approval",
              status: "waiting",
              waitEventType: "approval",
            }),
          ]);

          const receivedAt = harness.clock.now().toISOString();
          await harness.sendEvent("WORKFLOW", instanceId, {
            type: "approval",
            payload: { approved: true },
          });
          await harness.runUntilIdle({
            workflowName: "codemode-e2e-wait",
            instanceId,
            reason: "event",
          });
          await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
            status: "waiting",
          });
          const waitingHistory = await harness.getHistory("WORKFLOW", instanceId);
          expect(waitingHistory.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ stepKey: "waitForEvent:approval", status: "completed" }),
              expect.objectContaining({ stepKey: "sleep:cooldown", status: "waiting" }),
            ]),
          );
          expect(waitingHistory.emissions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ actor: "user", payload: { timestamp: receivedAt } }),
            ]),
          );

          harness.clock.advanceBy("2 seconds");
          await harness.restart();
          await harness.runUntilIdle({
            workflowName: "codemode-e2e-wait",
            instanceId,
            reason: "wake",
          });

          await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
            status: "complete",
            output: { approved: true, preservedDate: true },
          });
          const history = await harness.getHistory("WORKFLOW", instanceId);
          expect(history.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "approval",
                payload: { approved: true },
                consumedByStepKey: "waitForEvent:approval",
              }),
            ]),
          );
          expect(history.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ stepKey: "sleep:cooldown", status: "completed" }),
              expect.objectContaining({ stepKey: "do:save approval", status: "completed" }),
            ]),
          );
        } finally {
          await harness.test.cleanup();
        }
      });
    },
  );

  // The host keeps a guest's onEvent handler past the call that registered it.
  test.each(["test worker", "Durable Object"] as const)(
    "delivers events to a running step's onEvent handler from a %s",
    async (runner) => {
      await runInWorkflowRunner(runner, async (codemode) => {
        const instanceId = "codemode-on-event-1";
        let sendCommand: (input: { n: number }) => Promise<void> = async () => {
          throw new Error("The workflow is not running yet.");
        };
        const sendTool = defineBackofficeRuntimeTool({
          id: "probe.send",
          namespace: "probe",
          name: "send",
          description: "Send the running workflow a command.",
          requiredPermissions: [],
          inputSchema: z.object({ n: z.number() }),
          outputSchema: z.object({ sent: z.boolean() }),
          execute: async (input) => {
            await sendCommand(input);
            return { sent: true };
          },
        });
        const Workflow = defineRemoteWorkflow(
          { name: "codemode-on-event" },
          defineCodemodeWorkflowRun<unknown, unknown[]>(
            `async (_event, step) => {
              return await step.do("interactive", async (tx) => {
                const received = [];
                let delivered;
                const firstDelivery = new Promise((resolve) => {
                  delivered = resolve;
                });
                tx.onEvent("command", (event) => {
                  received.push(event.payload);
                  event.consume();
                  delivered();
                });
                await probe.send({ n: 1 });
                await firstDelivery;
                return received;
              });
            }`,
            codemode,
            {
              allowedHooks: [],
              origin: { kind: "inline" },
              modules: {},
              families: [
                defineBackofficeRuntimeToolFamily({ namespace: "probe", tools: [sendTool] }),
              ],
              toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
            },
          ),
        );
        const harness = await createHarness({ WORKFLOW: Workflow });
        sendCommand = async (input) => {
          await harness.sendEvent("WORKFLOW", instanceId, { type: "command", payload: input });
        };

        try {
          await harness.createInstance("WORKFLOW", {
            id: instanceId,
            remoteWorkflowName: "codemode-on-event-body",
          });
          await harness.runUntilIdle({
            workflowName: "codemode-on-event",
            instanceId,
            reason: "create",
          });

          await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
            status: "complete",
            output: [{ n: 1 }],
          });
          expect((await harness.getHistory("WORKFLOW", instanceId)).events).toEqual([
            expect.objectContaining({ type: "command", consumedByStepKey: "do:interactive" }),
          ]);
        } finally {
          await harness.test.cleanup();
        }
      });
    },
  );

  test("codemode workflow step tx can create another workflow instance", async () => {
    const ChildWorkflow = defineWorkflow<
      "codemode-child-created-workflow",
      { value: number },
      { value: number }
    >({ name: "codemode-child-created-workflow" }, async (event) => ({
      value: event.payload.value,
    }));
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-create-child" },
      defineCodemodeWorkflowRun<unknown, { childId: string }>(
        `async (_event, step) => {
          await step.do("create-child", async (tx) => {
            tx.workflowServiceCalls(() => [
              {
                type: "createInstance",
                workflowName: "codemode-child-created-workflow",
                instanceId: "codemode-child-created-1",
                params: { value: 42 },
              },
            ]);
          });
          return { childId: "codemode-child-created-1" };
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({
      WORKFLOW: Workflow,
      CHILD: ChildWorkflow,
    });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-create-child-1",
      remoteWorkflowName: "codemode-e2e-create-child-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-create-child",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: { childId: "codemode-child-created-1" },
    });
    await expect(harness.getStatus("CHILD", "codemode-child-created-1")).resolves.toMatchObject({
      status: "active",
    });
  });

  test("codemode workflow supports Promise.all, Promise.race, Promise.any, and Promise.allSettled in remote steps", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-promise-combinators" },
      defineCodemodeWorkflowRun<
        unknown,
        {
          all: string[];
          raceReturn: string;
          anyReturn: string;
          settled: Array<
            { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: string }
          >;
        }
      >(
        `async (_event, step) => {
          const all = await Promise.all([
            step.do("all alpha", async () => "A"),
            step.do("all beta", async () => "B"),
          ]);

          const raceReturn = await step.do("Promise race", async () => {
            return await Promise.race([
              step.do("race slow", async () => {
                await step.sleep("race slow delay", 1000);
                return "slow";
              }),
              step.do("race fast", async () => "fast"),
            ]);
          });

          const anyReturn = await step.do("Promise any", async () => {
            return await Promise.any([
              step.do("any slow", async () => {
                await step.sleep("any slow delay", 1000);
                return "slow";
              }),
              step.do("any fast", async () => "fast"),
            ]);
          });

          const settled = await step.do("Promise allSettled", async () => {
            const results = await Promise.allSettled([
              step.do("settled ok", async () => "ok"),
              step.do("settled fail", async () => {
                throw new Error("EXPECTED_SETTLED_FAILURE");
              }),
            ]);
            return results.map((result) => result.status === "fulfilled"
              ? { status: result.status, value: result.value }
              : {
                  status: result.status,
                  reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
          });

          return { all, raceReturn, anyReturn, settled };
        }`,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-promise-combinators-1",
      remoteWorkflowName: "codemode-e2e-promise-combinators-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-promise-combinators",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: {
        all: ["A", "B"],
        raceReturn: "fast",
        anyReturn: "fast",
        settled: [
          { status: "fulfilled", value: "ok" },
          { status: "rejected", reason: "EXPECTED_SETTLED_FAILURE" },
        ],
      },
    });

    const history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: "do:all alpha",
          status: "completed",
          result: "A",
        }),
        expect.objectContaining({
          stepKey: "do:all beta",
          status: "completed",
          result: "B",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race",
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race>do:race slow",
          parentStepKey: "do:Promise race",
          depth: 1,
          status: "waiting",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race>do:race slow>sleep:race slow delay",
          parentStepKey: "do:Promise race>do:race slow",
          depth: 2,
          status: "waiting",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race>do:race fast",
          parentStepKey: "do:Promise race",
          depth: 1,
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({
          stepKey: "do:Promise any",
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({
          stepKey: "do:Promise any>do:any slow",
          parentStepKey: "do:Promise any",
          depth: 1,
          status: "waiting",
        }),
        expect.objectContaining({
          stepKey: "do:Promise any>do:any fast",
          parentStepKey: "do:Promise any",
          depth: 1,
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({
          stepKey: "do:Promise allSettled",
          status: "completed",
        }),
        expect.objectContaining({
          stepKey: "do:Promise allSettled>do:settled ok",
          status: "completed",
          result: "ok",
        }),
        expect.objectContaining({
          stepKey: "do:Promise allSettled>do:settled fail",
          status: "errored",
          error: { message: "EXPECTED_SETTLED_FAILURE", name: "Error" },
        }),
      ]),
    );
  });

  test("commits allowed codemode hooks on success and terminal failure but rejects unlisted hooks", async () => {
    const hookSchema = schema("codemode-remote-hook-test", (s) => s);
    const hookFragment = defineFragment("codemode-remote-hook-test")
      .extend(withDatabase(hookSchema))
      .provideHooks(({ defineHook }) => ({
        onStepRecorded: defineHook(async function () {}),
      }))
      .build();
    const hookCode = `async (event, step) => {
          await step.do("record hook", async (tx) => {
            tx.triggerHook({
              target: "tenant",
              schemaName: "codemode-remote-hook-test",
              hookName: "onStepRecorded",
              payload: { instanceId: event.instanceId },
              when: "both",
            });
            if (event.payload.fail) {
              throw new Error("EXPECTED_REMOTE_FAILURE");
            }
          });
          return "done";
        }`;
    const allowedHooks: RemoteWorkflowAllowedHook[] = [];
    const Workflow = defineRemoteWorkflow<"codemode-remote-hook", { fail: boolean }>(
      { name: "codemode-remote-hook" },
      defineCodemodeWorkflowRun<{ fail: boolean }, string>(hookCode, codemode, {
        ...createSystemWorkflowOptions(),
        allowedHooks,
      }),
    );
    const DeniedWorkflow = defineRemoteWorkflow<"codemode-remote-hook-denied", { fail: boolean }>(
      { name: "codemode-remote-hook-denied" },
      defineCodemodeWorkflowRun<{ fail: boolean }, string>(
        hookCode,
        codemode,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow, DENIED: DeniedWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) => builder.withFragment("hookTest", instantiate(hookFragment)),
    });

    try {
      allowedHooks.push({
        target: "tenant",
        schemaName: hookSchema.name,
        hookName: "onStepRecorded",
        namespace: getDurableHooksService(harness.fragments.hookTest.fragment).namespace,
      });
      for (const [instanceId, fail] of [
        ["codemode-hook-success", false],
        ["codemode-hook-terminal", true],
      ] as const) {
        await harness.createInstance("WORKFLOW", {
          id: instanceId,
          params: { fail },
          remoteWorkflowName: "codemode-remote-hook-body",
        });
        await harness.runUntilIdle({
          workflowName: "codemode-remote-hook",
          instanceId,
          reason: "create",
        });
      }

      await harness.createInstance("DENIED", {
        id: "codemode-hook-denied",
        params: { fail: false },
        remoteWorkflowName: "codemode-remote-hook-body",
      });
      await harness.runUntilIdle({
        workflowName: "codemode-remote-hook-denied",
        instanceId: "codemode-hook-denied",
        reason: "create",
      });

      await expect(harness.getStatus("DENIED", "codemode-hook-denied")).resolves.toMatchObject({
        status: "errored",
        error: {
          message:
            "REMOTE_WORKFLOW_HOOK_NOT_ALLOWED: tenant/codemode-remote-hook-test/onStepRecorded",
        },
      });
      await expect(harness.getStatus("WORKFLOW", "codemode-hook-success")).resolves.toMatchObject({
        status: "complete",
        output: "done",
      });
      await expect(harness.getStatus("WORKFLOW", "codemode-hook-terminal")).resolves.toMatchObject({
        status: "errored",
        error: { message: "EXPECTED_REMOTE_FAILURE" },
      });
      expect((await harness.getHistory("WORKFLOW", "codemode-hook-success")).steps).toEqual([
        expect.objectContaining({ stepKey: "do:record hook", status: "completed" }),
      ]);
      expect((await harness.getHistory("WORKFLOW", "codemode-hook-terminal")).steps).toEqual([
        expect.objectContaining({ stepKey: "do:record hook", status: "errored" }),
      ]);

      const { hookService, namespace } = getDurableHooksService(
        harness.fragments.hookTest.fragment,
      );
      const hooks = await harness.fragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(() => [hookService.getHooksByNamespace(namespace)] as const)
          .transform(({ serviceResult: [records] }) => records)
          .execute();
      });
      expect(hooks).toHaveLength(2);
      expect(hooks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hookName: "onStepRecorded",
            payload: { instanceId: "codemode-hook-success" },
          }),
          expect.objectContaining({
            hookName: "onStepRecorded",
            payload: { instanceId: "codemode-hook-terminal" },
          }),
        ]),
      );
    } finally {
      await harness.test.cleanup();
    }
  });

  test("surfaces unsupported remote tx mutations as workflow errors", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-mutate-unsupported" },
      defineCodemodeWorkflowRun(
        `async (_event, step) => {
          await step.do("mutate", async (tx) => {
            tx.mutate(() => {});
            return "unreachable";
          });
        }`,
        codemode,
        {
          allowedHooks: [],
          origin: { kind: "inline" } as const,
          modules: {},
          families: runtimeToolFamilies,
          toolContext: createTrustedSystemBackofficeToolContext({
            runtimes: {},
          }),
        },
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-mutate-unsupported-1",
      remoteWorkflowName: "codemode-e2e-mutate-unsupported-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-mutate-unsupported",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "errored",
      error: { message: "REMOTE_WORKFLOW_TX_MUTATE_UNSUPPORTED" },
    });
    const history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual([
      expect.objectContaining({
        stepKey: "do:mutate",
        status: "errored",
        error: {
          message: "REMOTE_WORKFLOW_TX_MUTATE_UNSUPPORTED",
          name: "Error",
        },
      }),
    ]);
  });
});
