import { assert, describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { ScriptWorkflowGraph } from "./workflow-graph";
import type { ScriptWorkflowRun } from "./workflow-run-presentation";

const visualization = visualizeWorkflowSource(
  "automations/ui-results.workflow.js",
  `defineWorkflow({ name: "ui-results" }, async (_event, step) => {
    await step.do("ordinary step", async () => ({ count: 1 }));
    await step.do("UI step", async () => ({ $ui: reportUi }));
    return { $ui: finalUi };
  });`,
);

const ordinaryStep = visualization.graph.nodes.find(
  (node) => node.kind === "step" && node.label === "ordinary step",
);
const uiStep = visualization.graph.nodes.find(
  (node) => node.kind === "step" && node.label === "UI step",
);
assert(ordinaryStep?.kind === "step");
assert(uiStep?.kind === "step");

const run: ScriptWorkflowRun = {
  id: "run-row",
  instanceId: "run-1",
  workflowName: "ui-results",
  status: "complete",
  output: generatedUiResult("Final metric", "48"),
  createdAt: "2026-07-31T10:00:00.000Z",
  updatedAt: "2026-07-31T10:00:03.000Z",
  stepStatesByNodeId: new Map([
    [
      ordinaryStep.id,
      {
        status: "completed",
        attempts: 1,
        completedAt: "2026-07-31T10:00:01.000Z",
        result: { count: 1 },
        emissionCount: 0,
        current: false,
      },
    ],
    [
      uiStep.id,
      {
        status: "completed",
        attempts: 1,
        completedAt: "2026-07-31T10:00:02.000Z",
        result: generatedUiResult("Step metric", "24"),
        emissionCount: 0,
        current: false,
      },
    ],
  ]),
};

describe("ScriptWorkflowGraph generated UI presentation", () => {
  test("renders a generated interface from the final workflow output", () => {
    const markup = renderGraph("simple");

    expect(markup).toContain("Final output");
    expect(markup).toContain('aria-label="Final metric"');
    expect(markup).toContain(">48</p>");
  });

  test("UI mode shows only generated-UI steps and the final output", () => {
    const markup = renderGraph("ui");

    expect(markup).not.toContain("ordinary step");
    expect(markup).toContain("UI step");
    expect(markup).toContain('aria-label="Step metric"');
    expect(markup).toContain("Final output");
    expect(markup).toContain('aria-label="Final metric"');
    expect(markup).not.toContain("Final return");
  });
});

function renderGraph(detailMode: "simple" | "ui") {
  return renderToStaticMarkup(
    createElement(ScriptWorkflowGraph, {
      visualization,
      detailMode,
      runtimeToolCallsByStepId: new Map(),
      selectedRun: run,
    }),
  );
}

function generatedUiResult(label: string, value: string) {
  return {
    $ui: {
      version: 1,
      state: {},
      spec: {
        root: "metric",
        elements: {
          metric: {
            type: "Metric",
            props: { label, value },
            children: [],
          },
        },
      },
    },
  };
}
