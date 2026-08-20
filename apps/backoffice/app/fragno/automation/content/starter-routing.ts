import type {
  AutomationForwardEventAction,
  AutomationReclassifyEventAction,
  AutomationStartWorkflowAction,
  AutomationSendWorkflowEventAction,
} from "../routing";
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
  target: { kind: "stored_instance_id", keyTemplate: storedInstanceIdKeyTemplate },
  eventType,
  payload: payload ?? "$event",
});

const forwardToSubjectOrgAction = (): AutomationForwardEventAction => ({
  kind: "forward_event",
  targetScope: { kind: "org", orgIdTemplate: "${event.subject.orgId}" },
  idTemplate: "org:${event.id}",
});

const reclassifyGitHubEventAction = (
  eventType: string,
  fields: Record<string, string>,
): AutomationReclassifyEventAction => ({
  kind: "reclassify_event",
  source: "github",
  eventType,
  payload: { kind: "projection", fields },
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

export const STARTER_AUTOMATION_ROUTES: readonly AutomationRouteCreateInput[] = [
  {
    id: "github-issues-opened-reclassify",
    name: "Classify opened GitHub issues",
    enabled: true,
    trigger: {
      kind: "event",
      source: "github",
      eventType: "webhook.received",
      matcher: {
        all: [
          { path: "$.payload.githubEvent", op: "eq", value: "issues" },
          { path: "$.payload.action", op: "eq", value: "opened" },
        ],
      },
    },
    priority: 40,
    action: reclassifyGitHubEventAction("issues.opened", {
      deliveryId: "$.payload.deliveryId",
      installationId: "$.payload.installationId",
      repository: "$.payload.repository",
      issue: "$.payload.issue",
      sender: "$.payload.sender",
    }),
  },
  {
    id: "github-issue-comment-created-reclassify",
    name: "Classify created GitHub issue comments",
    enabled: true,
    trigger: {
      kind: "event",
      source: "github",
      eventType: "webhook.received",
      matcher: {
        all: [
          { path: "$.payload.githubEvent", op: "eq", value: "issue_comment" },
          { path: "$.payload.action", op: "eq", value: "created" },
        ],
      },
    },
    priority: 40,
    action: reclassifyGitHubEventAction("issue_comment.created", {
      deliveryId: "$.payload.deliveryId",
      installationId: "$.payload.installationId",
      repository: "$.payload.repository",
      issue: "$.payload.issue",
      comment: "$.payload.raw.comment",
      sender: "$.payload.sender",
    }),
  },
  {
    id: "github-pull-request-opened-reclassify",
    name: "Classify opened GitHub pull requests",
    enabled: true,
    trigger: {
      kind: "event",
      source: "github",
      eventType: "webhook.received",
      matcher: {
        all: [
          { path: "$.payload.githubEvent", op: "eq", value: "pull_request" },
          { path: "$.payload.action", op: "eq", value: "opened" },
        ],
      },
    },
    priority: 40,
    action: reclassifyGitHubEventAction("pull_request.opened", {
      deliveryId: "$.payload.deliveryId",
      installationId: "$.payload.installationId",
      repository: "$.payload.repository",
      pullRequest: "$.payload.pullRequest",
      sender: "$.payload.sender",
    }),
  },
  {
    id: "github-pull-request-synchronize-reclassify",
    name: "Classify synchronized GitHub pull requests",
    enabled: true,
    trigger: {
      kind: "event",
      source: "github",
      eventType: "webhook.received",
      matcher: {
        all: [
          { path: "$.payload.githubEvent", op: "eq", value: "pull_request" },
          { path: "$.payload.action", op: "eq", value: "synchronize" },
        ],
      },
    },
    priority: 40,
    action: reclassifyGitHubEventAction("pull_request.synchronize", {
      deliveryId: "$.payload.deliveryId",
      installationId: "$.payload.installationId",
      repository: "$.payload.repository",
      pullRequest: "$.payload.pullRequest",
      sender: "$.payload.sender",
    }),
  },
  {
    id: "github-push-reclassify",
    name: "Classify GitHub pushes",
    enabled: true,
    trigger: {
      kind: "event",
      source: "github",
      eventType: "webhook.received",
      matcher: { path: "$.payload.githubEvent", op: "eq", value: "push" },
    },
    priority: 40,
    action: reclassifyGitHubEventAction("push", {
      deliveryId: "$.payload.deliveryId",
      installationId: "$.payload.installationId",
      repository: "$.payload.repository",
      ref: "$.payload.raw.ref",
      before: "$.payload.raw.before",
      after: "$.payload.raw.after",
      sender: "$.payload.sender",
    }),
  },
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
      workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
      instanceIdTemplate: "telegram-pi-${event.id}",
    }),
  },
];
