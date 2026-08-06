import { AUTOMATION_CODEMODE_WORKFLOW } from "../engine/workflow-start";
import type {
  AutomationForwardEventAction,
  AutomationStartWorkflowAction,
  AutomationSendWorkflowEventAction,
} from "../routing";
import type { AutomationRouteCreateInput } from "../routing-schemas";

const startWorkflowAction = ({
  remoteWorkflowName,
  workflowScriptPath,
  instanceIdTemplate,
}: {
  remoteWorkflowName: string;
  workflowScriptPath: string;
  instanceIdTemplate: string;
}): AutomationStartWorkflowAction => ({
  kind: "start_workflow",
  remoteWorkflowName,
  workflowScriptPath,
  instanceIdTemplate,
});

const sendWorkflowEventAction = ({
  remoteWorkflowName,
  storedInstanceIdKeyTemplate,
  eventType,
  payload,
}: {
  remoteWorkflowName: string;
  storedInstanceIdKeyTemplate: string;
  eventType: string;
  payload?: unknown;
}): AutomationSendWorkflowEventAction => ({
  kind: "send_workflow_event",
  workflowName: AUTOMATION_CODEMODE_WORKFLOW,
  remoteWorkflowName,
  target: { kind: "stored_instance_id", keyTemplate: storedInstanceIdKeyTemplate },
  eventType,
  payload: payload ?? "$event",
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
      remoteWorkflowName: "workspace-file-initialization",
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

export const STARTER_AUTOMATION_ROUTES: readonly AutomationRouteCreateInput[] = [
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
      remoteWorkflowName: "project-files-configure",
      workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
      instanceIdTemplate: "project-files-configure-${event.id}",
    }),
  },
  {
    id: "telegram-start-linking",
    name: "Telegram /start identity linking",
    enabled: true,
    trigger: {
      kind: "event",
      source: "telegram",
      eventType: "message.received",
      matcher: { path: "$.payload.text", op: "eq", value: "/start" },
    },
    priority: 100,
    action: startWorkflowAction({
      remoteWorkflowName: "telegram-user-linking",
      workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
      instanceIdTemplate: "telegram-link-${event.id}",
    }),
  },
  {
    id: "telegram-identity-claim-completed",
    name: "Forward Telegram identity claim completion",
    enabled: true,
    trigger: {
      kind: "event",
      source: "otp",
      eventType: "identity.claim.completed",
      matcher: {
        actor: {
          participation: "initiator",
          scope: "external",
          source: "telegram",
        },
      },
    },
    priority: 90,
    action: sendWorkflowEventAction({
      remoteWorkflowName: "telegram-user-linking",
      storedInstanceIdKeyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
      eventType: "identity-claim-completed",
    }),
  },
  {
    id: "telegram-pi-linking",
    name: "Telegram Pi session linking",
    enabled: true,
    trigger: {
      kind: "event",
      source: "telegram",
      eventType: "message.received",
      matcher: {
        any: [
          { path: "$.payload.text", op: "eq", value: "/pi" },
          {
            all: [
              { path: "$.payload.text", op: "exists" },
              { not: { path: "$.payload.text", op: "startsWith", value: "/" } },
            ],
          },
        ],
      },
    },
    priority: 120,
    action: startWorkflowAction({
      remoteWorkflowName: "telegram-user-pi-linking",
      workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
      instanceIdTemplate: "telegram-pi-${event.id}",
    }),
  },
];
