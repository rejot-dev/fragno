import type { AutomationForwardEventAction, AutomationStartWorkflowAction } from "../routing";
import type { AutomationRouteCreateInput } from "../routing-schemas";

const startWorkflowAction = ({
  workflowScriptPath,
  instanceIdTemplate,
}: {
  workflowScriptPath: string;
  instanceIdTemplate: string;
}): AutomationStartWorkflowAction => ({
  kind: "start_workflow",
  authority: { kind: "organization-automation" },
  workflowScriptPath,
  instanceIdTemplate,
});

const forwardToSubjectOrgAction = (): AutomationForwardEventAction => ({
  kind: "forward_event",
  targetScope: { kind: "org", orgIdTemplate: "${event.subject.orgId}" },
  idTemplate: "org:${event.id}",
});

export const SYSTEM_STARTER_AUTOMATION_ROUTES: readonly AutomationRouteCreateInput[] = [
  {
    id: "system-workspace-file-initialization",
    name: "Initialize workspace files",
    enabled: true,
    trigger: {
      kind: "event",
      source: "auth",
      eventType: "organization.created",
      matcher: {
        all: [
          { path: "$.scope.kind", op: "eq", value: "system" },
          { path: "$.subject.orgId", op: "exists" },
        ],
      },
    },
    priority: 10,
    action: startWorkflowAction({
      workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
      instanceIdTemplate: "workspace-file-initialization-${event.id}",
    }),
  },
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
          { path: "$.subject.orgId", op: "exists" },
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
          { path: "$.subject.orgId", op: "exists" },
        ],
      },
    },
    priority: 20,
    action: forwardToSubjectOrgAction(),
  },
];

export const ORGANIZATION_STARTER_AUTOMATION_ROUTES: readonly AutomationRouteCreateInput[] = [
  {
    id: "system-project-files-configure",
    name: "Configure project files",
    enabled: true,
    trigger: {
      kind: "event",
      source: "automations",
      eventType: "project.created",
      matcher: null,
    },
    priority: 15,
    action: startWorkflowAction({
      workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
      instanceIdTemplate: "project-files-configure-${event.id}",
    }),
  },
];
