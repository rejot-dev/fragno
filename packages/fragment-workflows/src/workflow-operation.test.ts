import { describe, expect, test } from "vitest";

import type { WorkflowStepWorkflowOperation } from "./workflow";
import { validateAndNormalizeWorkflowOperation } from "./workflow-operation";

const workflowsByName = new Map([
  ["local-workflow", { remote: false }],
  ["remote-workflow-host", { remote: true }],
]);

describe("validateAndNormalizeWorkflowOperation", () => {
  test("rejects unsupported operation types from runtime callers", () => {
    const operation = {
      type: "terminateInstance",
      workflowName: "local-workflow",
      instanceId: "instance-1",
    } as unknown as WorkflowStepWorkflowOperation;

    expect(() => validateAndNormalizeWorkflowOperation(workflowsByName, operation)).toThrow(
      "WORKFLOW_STEP_WORKFLOW_OPERATION_UNSUPPORTED",
    );
  });

  test("rejects events targeting a remote workflow host", () => {
    expect(() =>
      validateAndNormalizeWorkflowOperation(workflowsByName, {
        type: "createEvent",
        workflowName: "remote-workflow-host",
        instanceId: "instance-1",
        eventId: "event-1",
        eventType: "approval",
      }),
    ).toThrow("WORKFLOW_EVENT_REMOTE_TARGET_UNSUPPORTED");
  });
});
