import { assert, describe, it } from "vitest";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { automationEventCatalogLink, automationRouteScriptLink } from "./route-links";

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

describe("automation route links", () => {
  it("opens the route workflow script in the scoped scripts tab", () => {
    const route = routeWithAction({
      kind: "start_workflow",
      workflowScriptPath: "/workspace/automations/telegram-linking.workflow.js",
      instanceIdTemplate: "telegram-${event}",
    });

    assert.equal(
      automationRouteScriptLink(route, "/backoffice/automations/org/acme/scripts"),
      "/backoffice/automations/org/acme/scripts?script=automation-script%3Aworkspace%3Atelegram-linking.workflow.js",
    );
  });

  it("does not link actions without a concrete workflow script", () => {
    const route = routeWithAction({
      kind: "send_workflow_event",
      workflowName: "automation-codemode",
      remoteWorkflowName: "telegram-linking",
      eventType: "continue",
      target: { kind: "instance_id", template: "instance-${event}" },
    });

    assert.equal(
      automationRouteScriptLink(route, "/backoffice/automations/org/acme/scripts"),
      null,
    );
  });

  it("opens a filtered event catalog", () => {
    assert.equal(
      automationEventCatalogLink(
        "/backoffice/automations/org/acme/events-catalog",
        "message.received",
      ),
      "/backoffice/automations/org/acme/events-catalog?search=message.received",
    );
  });
});
