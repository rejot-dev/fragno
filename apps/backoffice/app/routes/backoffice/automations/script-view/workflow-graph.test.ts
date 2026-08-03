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
  instanceWorkflowName: "automation-codemode-script",
  status: "complete",
  output: generatedUiResult("Final metric", "48"),
  createdAt: "2026-07-31T10:00:00.000Z",
  updatedAt: "2026-07-31T10:00:03.000Z",
  waitingEventTypes: [],
  workflowEvents: [],
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
  test("hides the final output toggle when filtering $ui leaves no data", () => {
    const markup = renderGraph("simple");

    expect(markup).toContain("Final return");
    expect(markup).not.toContain("data-workflow-final-return-output");
    expect(markup.match(/data-workflow-output/g)).toHaveLength(1);
    expect(markup).not.toContain("Final output");
    expect(markup).not.toContain('aria-label="Final metric"');
    expect(markup).not.toContain("&quot;$ui&quot;");
  });

  test("renders ordinary final output data inside the final return card", () => {
    const markup = renderToStaticMarkup(
      createElement(ScriptWorkflowGraph, {
        visualization,
        detailMode: "simple",
        runtimeToolCallsByStepId: new Map(),
        selectedRun: {
          ...run,
          output: { answer: "accepted", count: 3 },
        },
      }),
    );

    expect(markup).toContain("Final return");
    expect(markup).toContain('data-workflow-final-return-output="true"');
    expect(markup).toContain('data-workflow-output="true"');
    expect(markup).not.toContain('data-workflow-output="true" open');
    expect(markup).toContain("&quot;answer&quot;: &quot;accepted&quot;");
    expect(markup).toContain("&quot;count&quot;: 3");
  });

  test("does not repeat the static final return expression in verbose mode", () => {
    const markup = renderToStaticMarkup(
      createElement(ScriptWorkflowGraph, {
        visualization,
        detailMode: "verbose",
        runtimeToolCallsByStepId: new Map(),
        selectedRun: {
          ...run,
          output: { answer: "accepted" },
        },
      }),
    );

    expect(markup).toContain("Final return");
    expect(markup).toContain('data-workflow-final-return-output="true"');
    expect(markup).not.toContain("finalUi");
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

  test("merges a generated input step with its matching adjacent event waiter", () => {
    const inputVisualization = visualizeWorkflowSource(
      "automations/question.workflow.js",
      `defineWorkflow({ name: "question" }, async (_event, step) => {
        await step.do("ask-question", async () => ({ $ui: questionUi }));
        await step.waitForEvent("question-answer", { type: "question-answer", timeout: "1 day" });
      });`,
    );
    const askStep = inputVisualization.graph.nodes.find(
      (node) => node.kind === "step" && node.label === "ask-question",
    );
    const waitStep = inputVisualization.graph.nodes.find(
      (node) => node.kind === "step" && node.label === "question-answer",
    );
    assert(askStep?.kind === "step");
    assert(waitStep?.kind === "step");
    const inputRun: ScriptWorkflowRun = {
      ...run,
      id: "question-run-row",
      instanceId: "question-run",
      workflowName: "question",
      status: "waiting",
      output: null,
      waitingEventTypes: ["question-answer"],
      stepStatesByNodeId: new Map([
        [
          askStep.id,
          {
            stepRecordId: "ask-step-row",
            status: "completed",
            attempts: 1,
            completedAt: "2026-08-03T09:00:00.000Z",
            result: generatedQuestionUiResult(),
            emissionCount: 0,
            current: false,
          },
        ],
        [
          waitStep.id,
          {
            stepRecordId: "wait-step-row",
            status: "waiting",
            attempts: 1,
            waitEventType: "question-answer",
            emissionCount: 0,
            current: true,
          },
        ],
      ]),
    };
    const markup = renderToStaticMarkup(
      createElement(ScriptWorkflowGraph, {
        visualization: inputVisualization,
        detailMode: "simple",
        runtimeToolCallsByStepId: new Map(),
        selectedRun: inputRun,
      }),
    );

    expect(markup.match(/data-workflow-step-card/g)).toHaveLength(1);
    expect(markup).toContain("ask-question");
    expect(markup).not.toContain("question-answer");
    expect(markup).toContain("Waiting");
    expect(markup).not.toContain("Complete");
    expect(markup).toContain("1 durable step");
    expect(markup).not.toContain(">event<");
    expect(markup).not.toContain(">timeout<");
    expect(markup).not.toContain("1 day");
    expect(markup).not.toContain("bg-amber-500/8");

    const verboseMarkup = renderToStaticMarkup(
      createElement(ScriptWorkflowGraph, {
        visualization: inputVisualization,
        detailMode: "verbose",
        runtimeToolCallsByStepId: new Map(),
        selectedRun: inputRun,
      }),
    );
    expect(verboseMarkup).toContain(">event<");
    expect(verboseMarkup).toContain(">timeout<");
    expect(verboseMarkup).toContain("1 day");
  });
});

function renderGraph(detailMode: "simple" | "ui" | "verbose") {
  return renderToStaticMarkup(
    createElement(ScriptWorkflowGraph, {
      visualization,
      detailMode,
      runtimeToolCallsByStepId: new Map(),
      selectedRun: run,
    }),
  );
}

function generatedQuestionUiResult() {
  return {
    $ui: {
      version: 1,
      state: { response: { answer: "" } },
      spec: {
        root: "submit",
        elements: {
          submit: {
            type: "WorkflowEventButton",
            props: {
              label: "Submit answer",
              eventType: "question-answer",
              payload: { answer: { $state: "/response/answer" } },
            },
            children: [],
          },
        },
      },
    },
  };
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
