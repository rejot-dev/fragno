import { describe, expect, test, assert } from "vitest";

import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import {
  defineRemoteWorkflow,
  defineWorkflow,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";
import { z } from "zod";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import {
  createTrustedSystemBackofficeToolContext,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
} from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { defineCodemodeWorkflowRun, runBackofficeCodemodeWorkflow } from "./workflow-execute";

const createHarness = async <TRegistry extends WorkflowsRegistry>(workflows: TRegistry) =>
  await createWorkflowsTestHarness({
    workflows,
    adapter: { type: "in-memory" },
    testBuilder: buildDatabaseFragmentsTest(),
    autoTickHooks: false,
  });

const createSystemWorkflowOptions = () => ({
  fs: new InMemoryFs(),
  families: runtimeToolFamilies,
  toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
});

describe("codemode workflow execution", () => {
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
        env,
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
        env,
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
        expect.objectContaining({ stepKey: "do:compute", status: "completed", result: 42 }),
        expect.objectContaining({ stepKey: "do:double", status: "completed", result: 84 }),
      ]),
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
          env,
          fs: new InMemoryFs(),
          families: runtimeToolFamilies,
          toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
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
        env,
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
        expect.objectContaining({ stepKey: "sleep:pause", status: "completed" }),
        expect.objectContaining({ stepKey: "do:after-sleep", status: "completed" }),
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
        env,
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
        env,
        {
          fs: new InMemoryFs(),
          families: [
            defineBackofficeRuntimeToolFamily({
              namespace: "math",
              permissions: {},
              tools: [doubleTool],
            }),
          ],
          toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
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
        env,
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
      expect.objectContaining({ stepKey: "do:before", status: "completed", result: 1 }),
      expect.objectContaining({ stepKey: "waitForEvent:continue", status: "waiting" }),
    ]);

    await harness.sendEvent("WORKFLOW", instanceId, { type: "continue", payload: {} });
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
        expect.objectContaining({ stepKey: "do:before", status: "completed", result: 1 }),
        expect.objectContaining({ stepKey: "waitForEvent:continue", status: "completed" }),
        expect.objectContaining({ stepKey: "do:after", status: "completed", result: 1 }),
      ]),
    );
  });

  test("suspends and resumes a codemode workflow through waitForEvent", async () => {
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-e2e-wait" },
      defineCodemodeWorkflowRun<unknown, { approved: boolean }>(
        `async (_event, step) => {
          const approval = await step.waitForEvent("approval", { type: "approval" });
          return { approved: approval.payload.approved };
        }`,
        env,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-e2e-wait-1",
      remoteWorkflowName: "codemode-e2e-wait-body",
    });
    await harness.runUntilIdle({
      workflowName: "codemode-e2e-wait",
      instanceId,
      reason: "create",
    });

    const waitingStatus = await harness.getStatus("WORKFLOW", instanceId);
    expect(waitingStatus).toMatchObject({
      status: "waiting",
    });
    let history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.steps).toEqual([
      expect.objectContaining({
        stepKey: "waitForEvent:approval",
        status: "waiting",
        waitEventType: "approval",
      }),
    ]);

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
      status: "complete",
      output: { approved: true },
    });
    history = await harness.getHistory("WORKFLOW", instanceId);
    expect(history.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval",
          payload: { approved: true },
          consumedByStepKey: "waitForEvent:approval",
        }),
      ]),
    );
  });

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
        env,
        createSystemWorkflowOptions(),
      ),
    );
    const harness = await createHarness({ WORKFLOW: Workflow, CHILD: ChildWorkflow });

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
        env,
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
        expect.objectContaining({ stepKey: "do:all alpha", status: "completed", result: "A" }),
        expect.objectContaining({ stepKey: "do:all beta", status: "completed", result: "B" }),
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
        expect.objectContaining({ stepKey: "do:Promise allSettled", status: "completed" }),
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
        env,
        {
          fs: new InMemoryFs(),
          families: runtimeToolFamilies,
          toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
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
        error: { message: "REMOTE_WORKFLOW_TX_MUTATE_UNSUPPORTED", name: "Error" },
      }),
    ]);
  });
});
