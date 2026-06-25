import type {
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
  workflowName: "automation-codemode-script",
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
  workflowName: "automation-codemode-script",
  target: { kind: "stored_instance_id", keyTemplate: storedInstanceIdKeyTemplate },
  eventType,
  payload: payload ?? "$event",
});

export const STARTER_AUTOMATION_ROUTES: readonly AutomationRouteDefinition[] = [
  {
    id: "system-workspace-file-initialization",
    name: "Initialize workspace files",
    enabled: true,
    source: "auth",
    eventType: "organization.created",
    matcher: null,
    priority: 10,
    action: startWorkflowAction({
      remoteWorkflowName: "workspace-file-initialization",
      workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
      instanceIdTemplate: "workspace-file-initialization-${event.id}",
    }),
  },
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
      workflowScriptPath: "/system/automations/project-files-configure.workflow.js",
      instanceIdTemplate: "project-files-configure-${event.id}",
    }),
  },
  {
    id: "system-codemode-types-refresh-capability",
    name: "Refresh codemode types after capability configuration",
    enabled: true,
    source: "*",
    eventType: "capability.configured",
    matcher: null,
    priority: 20,
    action: startWorkflowAction({
      remoteWorkflowName: "codemode-types-refresh",
      workflowScriptPath: "/system/automations/codemode-types-refresh.workflow.js",
      instanceIdTemplate: "codemode-types-refresh-${event.id}",
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
    id: "system-codemode-types-refresh-mcp-changed",
    name: "Refresh codemode types after MCP server changes",
    enabled: true,
    source: "mcp",
    eventType: "server.configuration.changed",
    matcher: null,
    priority: 20,
    action: startWorkflowAction({
      remoteWorkflowName: "codemode-types-refresh",
      workflowScriptPath: "/system/automations/codemode-types-refresh.workflow.js",
      instanceIdTemplate: "codemode-types-refresh-${event.id}",
    }),
  },
  {
    id: "system-codemode-types-refresh-mcp-deleted",
    name: "Refresh codemode types after MCP server deletion",
    enabled: true,
    source: "mcp",
    eventType: "server.configuration.deleted",
    matcher: null,
    priority: 20,
    action: startWorkflowAction({
      remoteWorkflowName: "codemode-types-refresh",
      workflowScriptPath: "/system/automations/codemode-types-refresh.workflow.js",
      instanceIdTemplate: "codemode-types-refresh-${event.id}",
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
