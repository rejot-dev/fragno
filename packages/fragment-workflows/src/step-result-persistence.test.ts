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
