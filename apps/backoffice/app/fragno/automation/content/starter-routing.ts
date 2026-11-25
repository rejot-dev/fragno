import type {
  AutomationForwardEventAction,
  AutomationRouteCreateInput,
} from "@fragno-dev/backoffice-api/v0/automation";

const forwardToSubjectOrgAction = (): AutomationForwardEventAction => ({
  kind: "forward_event",
  targetScope: { kind: "subject" },
  idTemplate: "org:${event.id}",
});

export const SYSTEM_STARTER_AUTOMATION_ROUTES: readonly AutomationRouteCreateInput[] = [
  {
    id: "system-auth-organization-created-forward-to-org",
    name: "Forward organization-created auth events to the organization",
    enabled: true,
    trigger: {
      kind: "event",
      source: "auth",
      eventType: "organization.created",
      matcher: {
        all: [
          { path: "$.scope.kind", op: "eq", value: "system" },
          { path: "$.subject.scope.kind", op: "eq", value: "org" },
        ],
      },
    },
    priority: 20,
    action: forwardToSubjectOrgAction(),
  },
  {
    id: "system-auth-organization-updated-forward-to-org",
    name: "Forward organization-updated auth events to the organization",
    enabled: true,
    trigger: {
      kind: "event",
      source: "auth",
      eventType: "organization.updated",
      matcher: {
        all: [
          { path: "$.scope.kind", op: "eq", value: "system" },
          { path: "$.subject.scope.kind", op: "eq", value: "org" },
        ],
      },
    },
    priority: 20,
    action: forwardToSubjectOrgAction(),
  },
];

/**
 * Built-in routes the product no longer ships. Seeding deletes them from the scopes that still
 * hold them, such as the system scope of deployments seeded before they were retired.
 */
export const RETIRED_STARTER_AUTOMATION_ROUTE_IDS: readonly string[] = [
  "system-workspace-file-initialization",
];

/**
 * Changes whenever the built-in routes do. Each scope seeds its starter routes once per revision,
 * as its Automations object starts, so retiring a route reaches scopes seeded before.
 */
export const STARTER_AUTOMATION_ROUTES_REVISION = SYSTEM_STARTER_AUTOMATION_ROUTES.map(
  (route) => route.id,
).join("+");
