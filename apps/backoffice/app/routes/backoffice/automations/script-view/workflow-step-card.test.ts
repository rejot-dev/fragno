import { assert, describe, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SourceRange, StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";

import { WorkflowStepCard } from "./workflow-step-card";

const source: SourceRange = {
  path: "automations/runtime-tools.workflow.js",
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 20, line: 1, column: 20 },
};

const step: StepNode = {
  id: "step:configure",
  kind: "step",
  label: "configure",
  stepType: "do",
  workflowName: "runtime-tools",
  order: 1,
  sourceOrder: 1,
  parentId: "workflow:runtime-tools",
  source,
  meta: {},
  analysis: { status: "complete", invocations: [], returns: [] },
  construction: { status: "complete", phase: "complete" },
};

describe("WorkflowStepCard", () => {
  it("renders runtime-tool scope and prefers workflow-specific descriptions", () => {
    const runtimeToolCalls: ResolvedWorkflowRuntimeToolCall[] = [
      runtimeToolCall({
        id: "internal.detailed",
        name: "detailed",
        scope: "org",
        summary: "Concise tool summary.",
        description: "Detailed workflow explanation.",
      }),
      runtimeToolCall({
        id: "internal.fallback",
        name: "fallback",
        scope: "current",
        summary: "Fallback tool summary.",
      }),
    ];

    const markup = renderToStaticMarkup(
      createElement(WorkflowStepCard, { step, runtimeToolCalls }),
    );

    assert.include(markup, "Detailed workflow explanation.");
    assert.notInclude(markup, "Concise tool summary.");
    assert.include(markup, "Fallback tool summary.");
    assert.include(markup, ">scope<");
    assert.include(markup, ">org<");
    assert.include(markup, ">current<");
    assert.notInclude(markup, "Runtime operation");
  });

  it("renders a generated interface inline without raw-result controls", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowStepCard, {
        step,
        runState: {
          status: "completed",
          attempts: 1,
          emissionCount: 0,
          current: false,
          result: {
            recordId: "record-1",
            $ui: {
              version: 1,
              state: {},
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
          },
        },
      }),
    );

    assert.include(markup, "data-workflow-step-generated-ui");
    assert.include(markup, 'aria-label="Orders"');
    assert.notInclude(markup, "Raw result");
    assert.notInclude(markup, "Show result");
    assert.notInclude(markup, "record-1");
  });

  it.each([0, 1])("keeps waiting attempts %i labeled as waiting", (attempts) => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowStepCard, {
        step,
        runState: {
          status: "waiting",
          attempts,
          emissionCount: 0,
          current: true,
        },
      }),
    );

    assert.include(markup, "Waiting");
    assert.notInclude(markup, "Retrying");
  });

  it("highlights a waiting retry", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowStepCard, {
        step,
        runState: {
          status: "waiting",
          attempts: 2,
          emissionCount: 0,
          current: true,
        },
      }),
    );

    assert.include(markup, 'aria-current="step"');
    assert.include(markup, "Retrying");
    assert.include(markup, "· 2");
    assert.include(markup, "border-amber-500/55");
  });
});

function runtimeToolCall({
  id,
  name,
  scope,
  summary,
  description,
}: {
  id: string;
  name: string;
  scope: ResolvedWorkflowRuntimeToolCall["scope"];
  summary: string;
  description?: string;
}): ResolvedWorkflowRuntimeToolCall {
  return {
    invocation: {
      kind: "call",
      execution: "direct",
      callee: { kind: "reference", root: scope, path: ["internal", name] },
      source,
      construction: { status: "complete", phase: "complete" },
    },
    tool: {
      id,
      namespace: "internal",
      name,
      qualifiedName: `internal.${name}`,
      summary,
      ...(description ? { description } : {}),
    },
    scope,
  };
}
