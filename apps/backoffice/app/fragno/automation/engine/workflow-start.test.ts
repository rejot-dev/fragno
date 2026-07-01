import { describe, expect, test, assert } from "vitest";

import {
  createAutomationCodemodeWorkflowInstanceInput,
  createManualAutomationEvent,
} from "./workflow-start";

describe("automation workflow start helpers", () => {
  test("manual workflow params carry the instance id into workflowInstanceId", () => {
    const event = createManualAutomationEvent({
      orgId: "org-1",
      source: "manual",
      eventType: "manual.run",
      payload: { value: 42 },
      id: "run-org-1-test",
    });
    const input = createAutomationCodemodeWorkflowInstanceInput({
      event,
      workflowScriptPath: "/workspace/automations/demo.workflow.js",
      instanceId: event.id,
      remoteWorkflowName: "demo",
    });

    assert(input.instanceId === "run-org-1-test");
    expect(input.params.workflowInstanceId).toBe(input.instanceId);
    expect(input.params.automationEvent.payload).toEqual({ value: 42 });
    expect(input.params.idempotencyKey).toBe(input.instanceId);
  });
});
