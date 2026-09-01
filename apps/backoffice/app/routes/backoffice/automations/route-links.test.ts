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
  it("opens the route workflow script in the scoped files section", () => {
    const route = routeWithAction({
      kind: "start_workflow",
      authority: { kind: "organization-automation", grants: [] },
      workflowScriptPath: "/workspace/automations/telegram-linking.workflow.js",
      instanceIdTemplate: "telegram-${event}",
    });

    assert.equal(
      automationRouteScriptLink(route, "/backoffice/files/org/acme"),
      "/backoffice/files/org/acme/workspace/automations/telegram-linking.workflow.js",
    );
  });

  it("does not link actions without a concrete workflow script", () => {
    const route = routeWithAction({
      kind: "send_workflow_event",
      eventType: "continue",
      target: { kind: "instance_id", template: "instance-${event}" },
    });

    assert.equal(automationRouteScriptLink(route, "/backoffice/files/org/acme"), null);
  });

  it("opens a filtered event catalog", () => {
    assert.equal(
      automationEventCatalogLink(
        "/backoffice/automations/org/acme/events-catalog",
        "telegram",
        "message.received",
      ),
      "/backoffice/automations/org/acme/events-catalog?selection=event&selected=telegram%3Amessage.received",
    );
  });
});
