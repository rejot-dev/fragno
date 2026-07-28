import { describe, expect, test } from "vitest";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import {
  automationRouteMatchesWorkflowInstance,
  automationRouteWorkflowIdentity,
  automationRouteWorkflowName,
} from "./route-workflow";

const routeWithAction = (
  action: AutomationRouteDefinition["action"],
): AutomationRouteDefinition => ({
  id: "route-1",
  name: "Route one",
  enabled: true,
  priority: 100,
  trigger: {
    kind: "event",
    source: "telegram",
    eventType: "message.received",
    matcher: null,
  },
  action,
  nextOccurrenceAt: null,
});

describe("automation route workflow presentation", () => {
  test("send-event routes identify the saved workflow separately from its host", () => {
    const route = routeWithAction({
      kind: "send_workflow_event",
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "telegram-user-linking",
      target: { kind: "stored_instance_id", keyTemplate: "telegram/claim/${event.id}" },
      eventType: "identity-claim-completed",
    });

    expect(automationRouteWorkflowName(route)).toBe("telegram-user-linking");
    expect(automationRouteWorkflowIdentity(route)).toEqual({
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "telegram-user-linking",
      workflowScriptPath: null,
    });
    expect(
      automationRouteMatchesWorkflowInstance(route, {
        workflowName: "automation-codemode-script",
        remoteWorkflowName: "telegram-user-linking",
        params: { workflowScriptPath: "/workspace/automations/unrelated.workflow.js" },
      }),
    ).toBe(true);
  });

  test("start routes only match runs created from the same workflow script", () => {
    const route = routeWithAction({
      kind: "start_workflow",
      workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
      instanceIdTemplate: "telegram/link/${event.id}",
    });
    const instance = {
      workflowName: "automation-codemode-script",
      remoteWorkflowName: null,
      params: {
        workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
      },
    };

    expect(automationRouteMatchesWorkflowInstance(route, instance)).toBe(true);
    expect(
      automationRouteMatchesWorkflowInstance(route, {
        ...instance,
        params: { workflowScriptPath: "/workspace/automations/other.workflow.js" },
      }),
    ).toBe(false);
  });
});
