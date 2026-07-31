// @vitest-environment happy-dom

import { afterEach, assert, describe, test, vi } from "vitest";

import type { SourceRange, StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import { act, cleanup, render, screen } from "@testing-library/react";

import { WorkflowStepCard } from "./workflow-step-card";

const source: SourceRange = {
  path: "automations/completion.workflow.js",
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 20, line: 1, column: 20 },
};

const step: StepNode = {
  id: "step:complete",
  kind: "step",
  label: "build report",
  stepType: "do",
  workflowName: "completion",
  order: 1,
  sourceOrder: 1,
  parentId: "workflow:completion",
  source,
  meta: {},
  analysis: { status: "complete", invocations: [], returns: [] },
  construction: { status: "complete", phase: "complete" },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkflowStepCard completion presentation", () => {
  test("removes completion emphasis two seconds after the durable step completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T14:00:00.000Z"));

    const { container } = render(
      <WorkflowStepCard
        step={step}
        runState={{
          status: "completed",
          attempts: 1,
          completedAt: "2026-07-31T14:00:00.000Z",
          emissionCount: 0,
          current: false,
        }}
      />,
    );
    const card = container.querySelector("[data-workflow-step-card]");
    assert(card instanceof HTMLElement);

    assert(screen.getByText("Complete"));
    assert.include(card.className, "border-emerald-500/35");
    assert.include(card.className, "bg-emerald-500/5");

    await act(async () => {
      vi.advanceTimersByTime(2_001);
    });

    assert.notOk(screen.queryByText("Complete"));
    assert.notInclude(card.className, "border-emerald-500/35");
    assert.notInclude(card.className, "bg-emerald-500/5");
    assert.include(card.className, "border-[color:var(--bo-border)]");
    assert.include(card.className, "bg-[var(--bo-panel)]");
  });
});
