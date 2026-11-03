import { describe, expect, test } from "vitest";

import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type { OrchestrationGraph } from "@fragno-private/design-system/orchestration/orchestration-graph-model";

import { projectOrchestrationUniverse } from "./orchestration-universe";

const organization = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
const person = { kind: "user", userId: "user-1", jurisdiction: null } as const;

function graph(scopeLabel: string): OrchestrationGraph {
  return { scopeLabel, inlets: [], sources: [], events: [], routes: [], targets: [] };
}

function forwardRoute(id: string, orgIdTemplate: string): AutomationRouteDefinition {
  return {
    id,
    name: id,
    enabled: true,
    priority: 1000,
    trigger: { kind: "event", source: "bank", eventType: "received", matcher: null },
    action: { kind: "forward_event", targetScope: { kind: "org", orgIdTemplate } },
  } as AutomationRouteDefinition;
}

/** The universe Ada sees once her personal scope is read, with `routes` in it. */
function universeWith(routes: AutomationRouteDefinition[]) {
  return projectOrchestrationUniverse({
    organization: {
      scope: organization,
      graph: graph("Ada Labs"),
      routes: [],
      deliveries: [],
      calls: [
        { workflowId: "workflow:/workspace/automations/fetch.workflow.js", externalId: "web" },
      ],
    },
    projects: [],
    viewer: {
      scope: person,
      label: "Ada",
      read: { graph: graph("Ada"), routes, deliveries: [], calls: [] },
    },
    recentForwards: [],
  });
}

describe("the universe of an organization", () => {
  test("leaves out the person looking while their scope and the organization's do not meet", () => {
    expect(universeWith([forwardRoute("elsewhere", "org-2")]).scopes.map(({ id }) => id)).toEqual([
      "org:org-1",
    ]);
  });

  test("names the scope of each workflow that calls an outside system", () => {
    expect(universeWith([]).calls).toEqual([
      {
        scopeId: "org:org-1",
        workflowId: "workflow:/workspace/automations/fetch.workflow.js",
        externalId: "web",
      },
    ]);
  });

  test("shows the person looking once a route of theirs names the organization", () => {
    const universe = universeWith([forwardRoute("balances-to-org", "org-1")]);
    expect(universe.scopes.map(({ id }) => id)).toEqual(["org:org-1", "user:user-1"]);
    expect(universe.forwards).toEqual([
      { routeId: "balances-to-org", fromScopeId: "user:user-1", toScopeId: "org:org-1" },
    ]);
  });
});
