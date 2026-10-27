import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import type { OrchestrationGraph } from "@fragno-private/design-system/orchestration-graph-model";

import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";

/**
 * Everything the landing page's dashboard shows, in the shapes the real dashboard renders. The
 * landing page shows one snapshot; an animation steps through snapshots over `now`.
 */
export type DashboardDemoState = {
  now: number;
  attention: readonly DashboardDemoAttention[];
  graph: OrchestrationGraph;
  workflows: readonly DashboardDemoWorkflow[];
  eventSources: readonly string[];
  /** One entry per hour, oldest first, counting events per source. */
  eventsPerHour: readonly Readonly<Record<string, number>>[];
  connections: readonly DashboardDemoConnection[];
  agents: readonly DashboardDemoAgent[];
};

// The landing page shows a healthy scope, so the only thing that needs attention is a waiting run.
export type DashboardDemoAttention = { workflow: string; updatedAt: Date };

export type DashboardDemoWorkflow = {
  name: string;
  startsPerHour: readonly number[];
  successRate: number;
  latestStatus: WorkflowInstanceStatus;
  latestAt: Date;
};

export type DashboardDemoConnection = {
  id: string;
  displayName: string;
  kindLabel: string;
  state: IntegrationConnectionRecord["state"];
  changedAt: Date;
};

export type DashboardDemoAgent = {
  name: string;
  activity: string;
  answering: boolean;
  turnsPerHour: readonly number[];
};

const NOW = Date.UTC(2026, 9, 26, 14, 30);
const MINUTE = 60_000;

function before(duration: number) {
  return new Date(NOW - duration);
}

const EVENT_SOURCES = ["github", "telegram", "forms", "scheduler"];

// A working day: quiet overnight, busy from nine to six.
const ACTIVITY = [0, 0, 0, 0, 0, 1, 1, 2, 4, 7, 9, 8, 6, 8, 9, 10, 9, 7, 5, 3, 2, 1, 1, 0];

function scaled(factor: number, offset: number) {
  return ACTIVITY.map((value, hour) => Math.round(value * factor + ((hour + offset) % 3) * factor));
}

export const DASHBOARD_DEMO_STATE: DashboardDemoState = {
  now: NOW,
  attention: [{ workflow: "customer-intake", updatedAt: before(2 * MINUTE) }],
  graph: {
    scopeLabel: "Acme",
    sources: [
      { id: "github", label: "GitHub", icon: "git-branch" },
      { id: "telegram", label: "Telegram", icon: "send" },
      { id: "forms", label: "Forms", icon: "file-text" },
      { id: "scheduler", label: "Scheduler", icon: "calendar" },
    ],
    events: [
      {
        id: "github:pull_request.opened",
        sourceId: "github",
        eventType: "pull_request.opened",
        label: "Pull request opened",
        recentCount: 6,
      },
      {
        id: "telegram:message.received",
        sourceId: "telegram",
        eventType: "message.received",
        label: "Telegram message received",
        recentCount: 9,
      },
      {
        id: "forms:response.submitted",
        sourceId: "forms",
        eventType: "response.submitted",
        label: "Form response submitted",
        recentCount: 3,
      },
      {
        id: "scheduler:schedule.triggered",
        sourceId: "scheduler",
        eventType: "schedule.triggered",
        label: "Schedule triggered",
        recentCount: 1,
      },
    ],
    routes: [
      {
        id: "review-pull-requests",
        eventId: "github:pull_request.opened",
        label: "Review opened pull requests",
        priority: 10,
        enabled: true,
        matcher: '$.repository.full_name equals "acme/web"',
        action: { kind: "start_workflow", targetId: "pull-request-review" },
      },
      {
        id: "triage-messages",
        eventId: "telegram:message.received",
        label: "Triage support messages",
        priority: 20,
        enabled: true,
        matcher: null,
        action: { kind: "notify_agent", targetId: "assistant" },
      },
      {
        id: "intake-responses",
        eventId: "forms:response.submitted",
        label: "Start customer intake",
        priority: 10,
        enabled: true,
        matcher: null,
        action: { kind: "start_workflow", targetId: "customer-intake" },
      },
      {
        id: "nightly-invoices",
        eventId: "scheduler:schedule.triggered",
        label: "Sync invoices nightly",
        priority: 10,
        enabled: true,
        matcher: null,
        action: { kind: "start_workflow", targetId: "sync-invoices" },
      },
    ],
    targets: [
      { id: "pull-request-review", label: "pull-request-review", kind: "workflow", activeCount: 1 },
      { id: "assistant", label: "Assistant", kind: "agent", activeCount: 1 },
      { id: "customer-intake", label: "customer-intake", kind: "workflow", activeCount: 1 },
      { id: "sync-invoices", label: "sync-invoices", kind: "workflow", activeCount: 0 },
    ],
  },
  workflows: [
    {
      name: "pull-request-review",
      startsPerHour: scaled(0.4, 0),
      successRate: 100,
      latestStatus: "active",
      latestAt: before(1 * MINUTE),
    },
    {
      name: "customer-intake",
      startsPerHour: scaled(0.25, 1),
      successRate: 100,
      latestStatus: "waiting",
      latestAt: before(2 * MINUTE),
    },
    {
      name: "triage-message",
      startsPerHour: scaled(0.6, 2),
      successRate: 100,
      latestStatus: "complete",
      latestAt: before(6 * MINUTE),
    },
    {
      name: "sync-invoices",
      startsPerHour: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2],
      successRate: 100,
      latestStatus: "complete",
      latestAt: before(14 * MINUTE),
    },
    {
      name: "publish-digest",
      startsPerHour: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      successRate: 100,
      latestStatus: "complete",
      latestAt: before(330 * MINUTE),
    },
  ],
  eventSources: EVENT_SOURCES,
  eventsPerHour: ACTIVITY.map((value, hour) => ({
    github: Math.round(value * 0.5 + (hour % 2)),
    telegram: Math.round(value * 0.9),
    forms: Math.round(value * 0.3),
    scheduler: hour === 2 ? 1 : 0,
  })),
  connections: [
    {
      id: "github",
      displayName: "GitHub",
      kindLabel: "GitHub App",
      state: "ready",
      changedAt: before(3 * 24 * 60 * MINUTE),
    },
    {
      id: "telegram",
      displayName: "Telegram",
      kindLabel: "Bot",
      state: "ready",
      changedAt: before(5 * 24 * 60 * MINUTE),
    },
    {
      id: "stripe",
      displayName: "Stripe",
      kindLabel: "MCP",
      state: "ready",
      changedAt: before(14 * MINUTE),
    },
    {
      id: "slack",
      displayName: "Slack",
      kindLabel: "API",
      state: "ready",
      changedAt: before(9 * 24 * 60 * MINUTE),
    },
  ],
  agents: [
    {
      name: "Assistant",
      activity: "Answering in Telegram",
      answering: true,
      turnsPerHour: scaled(0.5, 1),
    },
    {
      name: "Reviewer",
      activity: "Last active 1m ago",
      answering: false,
      turnsPerHour: scaled(0.3, 2),
    },
  ],
};
