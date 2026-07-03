import { AUTOMATION_CODEMODE_WORKFLOW } from "../engine/workflow-start";
import type {
  AutomationForwardEventAction,
  AutomationRouteDefinition,
  AutomationStartWorkflowAction,
  AutomationSendWorkflowEventAction,
} from "../routing";

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
  workflowName: AUTOMATION_CODEMODE_WORKFLOW,
  remoteWorkflowName,
  workflowScriptPath,
  instanceIdTemplate,
});

const sendWorkflowEventAction = ({
  storedInstanceIdKeyTemplate,
  eventType,
  payload,
}: {
  storedInstanceIdKeyTemplate: string;
  eventType: string;
  payload?: unknown;
}): AutomationSendWorkflowEventAction => ({
  kind: "send_workflow_event",
  workflowName: AUTOMATION_CODEMODE_WORKFLOW,
  target: { kind: "stored_instance_id", keyTemplate: storedInstanceIdKeyTemplate },
  eventType,
  payload: payload ?? "$event",
});

const forwardToSubjectOrgAction = (): AutomationForwardEventAction => ({
  kind: "forward_event",
  targetScope: { kind: "org", orgIdTemplate: "${event.subject.orgId}" },
  idTemplate: "org:${event.id}",
});

export const SYSTEM_STARTER_AUTOMATION_ROUTES: readonly AutomationRouteDefinition[] = [
  {
    id: "system-workspace-file-initialization",
    name: "Initialize workspace files",
    enabled: true,
    source: "auth",
    eventType: "organization.created",
    matcher: {
      all: [
        { path: "$.scope.kind", op: "eq", value: "system" },
        { path: "$.subject.orgId", op: "exists" },
      ],
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
    source: "auth",
    eventType: "organization.created",
    matcher: {
      all: [
        { path: "$.scope.kind", op: "eq", value: "system" },
        { path: "$.subject.orgId", op: "exists" },
      ],
    },
    priority: 20,
    action: forwardToSubjectOrgAction(),
  },
  {
    id: "system-auth-organization-updated-forward-to-org",
    name: "Forward organization-updated auth events to the organization",
    enabled: true,
    source: "auth",
    eventType: "organization.updated",
    matcher: {
      all: [
        { path: "$.scope.kind", op: "eq", value: "system" },
        { path: "$.subject.orgId", op: "exists" },
      ],
    },
    priority: 20,
    action: forwardToSubjectOrgAction(),
  },
];

export const STARTER_AUTOMATION_ROUTES: readonly AutomationRouteDefinition[] = [
  {
    id: "system-project-files-configure",
    name: "Configure project files",
    enabled: true,
    source: "automations",
    eventType: "project.created",
    matcher: null,
    priority: 15,
    action: startWorkflowAction({
      remoteWorkflowName: "project-files-configure",
      workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
      instanceIdTemplate: "project-files-configure-${event.id}",
    }),
  },
  {
    id: "pi-default-agent-configure",
    name: "Configure default Pi agent",
    enabled: true,
    source: "pi",
    eventType: "capability.configured",
    matcher: {
      all: [
        { path: "$.payload.harnesses[0].id", op: "exists" },
        { path: "$.payload.modelCatalog[0].provider", op: "exists" },
        { path: "$.payload.modelCatalog[0].name", op: "exists" },
      ],
    },
    priority: 25,
    action: startWorkflowAction({
      remoteWorkflowName: "pi-default-agent-configure",
      workflowScriptPath: "/workspace/automations/pi-default-agent-configure.workflow.js",
      instanceIdTemplate: "pi-default-agent-configure-${event.id}",
    }),
  },
  {
    id: "telegram-start-linking",
    name: "Telegram /start identity linking",
    enabled: true,
    source: "telegram",
    eventType: "message.received",
    matcher: { path: "$.payload.text", op: "eq", value: "/start" },
    priority: 100,
    action: startWorkflowAction({
      remoteWorkflowName: "telegram-user-linking",
      workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
      instanceIdTemplate: "telegram-link-${event.id}",
    }),
  },
  {
    id: "telegram-test-command",
    name: "Telegram /test command",
    enabled: true,
    source: "telegram",
    eventType: "message.received",
    matcher: { path: "$.payload.text", op: "eq", value: "/test" },
    priority: 110,
    action: startWorkflowAction({
      remoteWorkflowName: "telegram-test-command",
      workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
      instanceIdTemplate: "telegram-test-${event.id}",
    }),
  },
  {
    id: "telegram-identity-claim-completed",
    name: "Forward Telegram identity claim completion",
    enabled: true,
    source: "otp",
    eventType: "identity.claim.completed",
    matcher: { path: "$.actor.source", op: "eq", value: "telegram" },
    priority: 90,
    action: sendWorkflowEventAction({
      storedInstanceIdKeyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
      eventType: "identity-claim-completed",
    }),
  },
  {
    id: "telegram-pi-linking",
    name: "Telegram Pi session linking",
    enabled: true,
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
    priority: 120,
    action: startWorkflowAction({
      remoteWorkflowName: "telegram-user-pi-linking",
      workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
      instanceIdTemplate: "telegram-pi-${event.id}",
    }),
  },
];
