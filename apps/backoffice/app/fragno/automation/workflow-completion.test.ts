import { assert, describe, expect, test } from "vitest";

import {
  parseWorkflowCompletionTarget,
  withWorkflowCompletionTarget,
  workflowCompletedEventType,
  workflowCompletionEventId,
  WORKFLOW_COMPLETION_PARAM,
} from "./workflow-completion";

describe("workflow completion events", () => {
  test("identifies every terminal transition within a workflow run", () => {
    assert.equal(workflowCompletedEventType(1), "workflow.completed:1");
    assert.equal(workflowCompletedEventType(2), "workflow.completed:2");
    assert.equal(
      workflowCompletionEventId({
        instanceRef: "child-ref",
        runGeneration: 1,
        terminalTransitionId: "transition-1",
      }),
      "workflow-completed:child-ref:1:transition-1",
    );
    assert.equal(
      workflowCompletionEventId({
        instanceRef: "child-ref",
        runGeneration: 1,
        terminalTransitionId: "transition-2",
      }),
      "workflow-completed:child-ref:1:transition-2",
    );
  });
});

describe("workflow completion targets", () => {
  test("returns null when completion routing is absent", () => {
    expect(parseWorkflowCompletionTarget(null)).toBeNull();
    expect(parseWorkflowCompletionTarget({})).toBeNull();
  });

  test("parses a persisted completion target", () => {
    const params = withWorkflowCompletionTarget(
      { value: 42 },
      { workflowName: "parent-workflow", instanceId: "parent-1" },
    );

    expect(parseWorkflowCompletionTarget(params)).toEqual({
      workflowName: "parent-workflow",
      instanceId: "parent-1",
    });
  });

  test("ignores malformed persisted completion routing", () => {
    expect(
      parseWorkflowCompletionTarget({
        [WORKFLOW_COMPLETION_PARAM]: { workflowName: "parent-workflow" },
      }),
    ).toBeNull();
  });
});
