import { describe, expect, test } from "vitest";

import {
  parseWorkflowCompletionTarget,
  withWorkflowCompletionTarget,
  WORKFLOW_COMPLETION_PARAM,
} from "./workflow-completion";

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
