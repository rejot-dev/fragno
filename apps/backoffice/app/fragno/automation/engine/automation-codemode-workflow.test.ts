import { describe, expect, test, assert } from "vitest";

import { AUTOMATION_SYSTEM_INITIATOR } from "../actors";
import type { AutomationEvent } from "../contracts";
import { createAutomationCodemodeWorkflowInstanceInput } from "./workflow-start";

describe("automation codemode workflow", () => {
  test("manual workflow params carry the instance id into workflowInstanceId", () => {
    const event: AutomationEvent = {
      id: "run-org-1-test",
      scope: { kind: "org", orgId: "org-1" },
      source: "manual",
      eventType: "manual.run",
      occurredAt: "2026-08-06T12:00:00.000Z",
      payload: { value: 42 },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
      subject: { orgId: "org-1" },
    };
    const input = createAutomationCodemodeWorkflowInstanceInput({
      event,
      authority: {
        mode: { kind: "organization-automation" },
        automationId: "automation-route:demo",
      },
      workflowScriptPath: "/workspace/automations/demo.workflow.js",
      instanceId: event.id,
      remoteWorkflowName: "demo",
    });

    assert(input.instanceId === "run-org-1-test");
    expect(input.params.workflowInstanceId).toBe(input.instanceId);
    expect(input.params.script).toEqual({
      kind: "file",
      path: "/workspace/automations/demo.workflow.js",
    });
    expect(input.params.automationEvent.payload).toEqual({ value: 42 });
    expect(input.params.idempotencyKey).toBe(input.instanceId);
    expect(input.params.metadata.__backofficeActors).toEqual({
      initiator: event.actors.initiator,
      principal: {
        scope: "internal",
        type: "automation",
        id: "automation-route:demo",
        role: "principal",
      },
      delegation: [],
    });
  });
});
