import { describe, expect, test, assert } from "vitest";

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
  test("send-event routes do not claim ownership of a saved workflow", () => {
    const route = routeWithAction({
      kind: "send_workflow_event",
      target: { kind: "stored_instance_id", keyTemplate: "telegram/claim/${event.id}" },
      eventType: "identity-claim-completed",
    });

    assert(automationRouteWorkflowName(route) === null);
    expect(automationRouteWorkflowIdentity(route)).toBeNull();
    assert(
      !automationRouteMatchesWorkflowInstance(route, {
        workflowName: "codemode-script",
        remoteWorkflowName: "telegram-user-linking",
        workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
      }),
    );
  });

  test("start routes only match runs created from the same workflow script", () => {
    const route = routeWithAction({
      kind: "start_workflow",
      authority: { kind: "organization-automation" },
      workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
      instanceIdTemplate: "telegram/link/${event.id}",
    });
    const instance = {
      workflowName: "codemode-script",
      remoteWorkflowName: null,
      workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
    };

    assert(automationRouteMatchesWorkflowInstance(route, instance));
    assert(
      !automationRouteMatchesWorkflowInstance(route, {
        ...instance,
        workflowScriptPath: "/workspace/automations/other.workflow.js",
      }),
    );
  });
});
