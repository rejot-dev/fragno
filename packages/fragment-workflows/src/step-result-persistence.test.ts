import { assert, describe, expect, test } from "vitest";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createWorkflowsTestHarness } from "./test";
import { defineWorkflow } from "./workflow";

const generatedUiResult = {
  recordId: "record-24",
  $ui: {
    version: 1,
    state: { count: 24 },
    spec: {
      root: "metric",
      elements: {
        metric: {
          type: "Metric",
          props: { label: "Orders", value: "24" },
          children: [],
        },
      },
    },
  },
} as const;

const DurableGeneratedUiWorkflow = defineWorkflow<
  "durable-generated-ui",
  undefined,
  { consumedRecordId: string }
>({ name: "durable-generated-ui" }, async (_event, step) => {
  const report = await step.do("build report", async () => generatedUiResult);
  await step.sleep("pause before consuming report", "1 hour");

  return await step.do("consume report data", async () => ({
    consumedRecordId: report.recordId,
  }));
});

describe("durable workflow step results", () => {
  test("commits progress between sequential top-level steps when configured", async () => {
    const executedSteps: string[] = [];
    const CheckpointedWorkflow = defineWorkflow(
      { name: "checkpointed-workflow", checkpoint: "step" },
      async (_event, step) => {
        const first = await step.do("first", () => {
          executedSteps.push("first");
          return 1;
        });
        const second = await step.do("second", () => {
          executedSteps.push("second");
          return first + 1;
        });
        return await step.do("third", () => {
          executedSteps.push("third");
          return second + 1;
        });
      },
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { CHECKPOINTED: CheckpointedWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    const instanceId = await harness.createInstance("CHECKPOINTED", { id: "checkpointed-1" });

    await harness.tick({
      workflowName: "checkpointed-workflow",
      instanceId,
      reason: "create",
    });
    expect(executedSteps).toEqual(["first"]);
    expect((await harness.getHistory("CHECKPOINTED", instanceId)).steps).toMatchObject([
      { stepKey: "do:first", status: "completed", result: 1 },
    ]);

    await harness.restart();
    await harness.tick({
      workflowName: "checkpointed-workflow",
      instanceId,
      reason: "wake",
    });
    expect(executedSteps).toEqual(["first", "second"]);
    expect((await harness.getHistory("CHECKPOINTED", instanceId)).steps).toMatchObject([
      { stepKey: "do:first", status: "completed", result: 1 },
      { stepKey: "do:second", status: "completed", result: 2 },
    ]);

    await harness.restart();
    await harness.tick({
      workflowName: "checkpointed-workflow",
      instanceId,
      reason: "wake",
    });
    expect(executedSteps).toEqual(["first", "second", "third"]);
    const status = await harness.getStatus("CHECKPOINTED", instanceId);
    assert(status.status === "complete");
    assert(status.output === 3);
  });

  test("checkpoints after top-level waits complete", async () => {
    const executedSteps: string[] = [];
    const SleepCheckpointWorkflow = defineWorkflow(
      { name: "sleep-checkpoint-workflow", checkpoint: "step" },
      async (_event, step) => {
        await step.sleep("pause", "1 hour");
        await step.do("after sleep", () => {
          executedSteps.push("after sleep");
        });
      },
    );
    const EventCheckpointWorkflow = defineWorkflow(
      { name: "event-checkpoint-workflow", checkpoint: "step" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        await step.do("after event", () => {
          executedSteps.push("after event");
        });
      },
    );
    const harness = await createWorkflowsTestHarness({
      workflows: {
        SLEEP_CHECKPOINT: SleepCheckpointWorkflow,
        EVENT_CHECKPOINT: EventCheckpointWorkflow,
      },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const sleepInstanceId = await harness.createInstance("SLEEP_CHECKPOINT", {
      id: "sleep-checkpoint-1",
    });
    await harness.tick({
      workflowName: "sleep-checkpoint-workflow",
      instanceId: sleepInstanceId,
      reason: "create",
    });
    harness.clock.advanceBy("1 hour");
    await harness.tick({
      workflowName: "sleep-checkpoint-workflow",
      instanceId: sleepInstanceId,
      reason: "wake",
    });
    expect(executedSteps).toEqual([]);
    expect((await harness.getHistory("SLEEP_CHECKPOINT", sleepInstanceId)).steps).toMatchObject([
      { stepKey: "sleep:pause", status: "completed" },
    ]);

    await harness.tick({
      workflowName: "sleep-checkpoint-workflow",
      instanceId: sleepInstanceId,
      reason: "wake",
    });
    expect(executedSteps).toEqual(["after sleep"]);

    const eventInstanceId = await harness.createInstance("EVENT_CHECKPOINT", {
      id: "event-checkpoint-1",
    });
    await harness.tick({
      workflowName: "event-checkpoint-workflow",
      instanceId: eventInstanceId,
      reason: "create",
    });
    await harness.sendEvent("EVENT_CHECKPOINT", eventInstanceId, {
      type: "ready",
    });
    await harness.tick({
      workflowName: "event-checkpoint-workflow",
      instanceId: eventInstanceId,
      reason: "event",
    });
    expect(executedSteps).toEqual(["after sleep"]);
    expect((await harness.getHistory("EVENT_CHECKPOINT", eventInstanceId)).steps).toMatchObject([
      { stepKey: "waitForEvent:ready", status: "completed" },
    ]);

    await harness.tick({
      workflowName: "event-checkpoint-workflow",
      instanceId: eventInstanceId,
      reason: "wake",
    });
    expect(executedSteps).toEqual(["after sleep", "after event"]);
  });

  test("replays generated UI results while preserving ordinary dataflow", async () => {
    const harness = await createWorkflowsTestHarness({
      workflows: { GENERATED_UI: DurableGeneratedUiWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    const instanceId = await harness.createInstance("GENERATED_UI", { id: "generated-ui-1" });

    await harness.runUntilIdle({
      workflowName: "durable-generated-ui",
      instanceId,
      reason: "create",
    });

    const waitingHistory = await harness.getHistory("GENERATED_UI", instanceId);
    expect(waitingHistory.steps.find((step) => step.stepKey === "do:build report")?.result).toEqual(
      generatedUiResult,
    );

    await harness.restart();
    harness.clock.advanceBy("1 hour");
    await harness.runUntilIdle({
      workflowName: "durable-generated-ui",
      instanceId,
      reason: "wake",
    });

    const status = await harness.getStatus("GENERATED_UI", instanceId);
    assert(status.status === "complete");
    expect(status.output).toEqual({ consumedRecordId: "record-24" });

    const completedHistory = await harness.getHistory("GENERATED_UI", instanceId);
    expect(
      completedHistory.steps.find((step) => step.stepKey === "do:build report")?.result,
    ).toEqual(generatedUiResult);
  });
});
