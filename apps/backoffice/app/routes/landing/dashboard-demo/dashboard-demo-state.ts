import type { PresencePerson } from "@fragno-private/design-system/feedback/presence-stack";
import type { IconName } from "@fragno-private/design-system/icon";

/**
 * Everything the landing page's dashboard shows, in the shapes the real dashboard's Overview
 * renders. The landing page shows one snapshot; an animation steps through snapshots over `now`.
 */
export type DashboardDemoState = {
  now: number;
  scopeLabel: string;
  /** Who else is in the organization now, as the top bar's presence stack shows them. */
  people: readonly PresencePerson[];
  attention: readonly DashboardDemoAttention[];
  recentActivity: readonly DashboardDemoActivity[];
  /** The Integrations page's connections once the first story has connected Google Drive and Slack. */
  connections: readonly DashboardDemoConnection[];
  /** The first run of the workflow the third story writes, at the top of Recent activity. */
  automatedRun: DashboardDemoActivity;
  /** The page the agent writes in the story, once it opens as a tab. */
  signups: DashboardDemoSignups;
};

// The landing page shows a healthy scope, so the only thing that needs attention is a waiting run.
export type DashboardDemoAttention = { workflow: string; updatedAt: Date };

/** One row of Recent activity: what an event set in motion, what set it off, and how it went. */
export type DashboardDemoActivity = {
  id: string;
  title: string;
  trigger: string;
  icon: IconName;
  outcome:
    | { kind: "running" }
    | { kind: "waiting" }
    | { kind: "settled"; duration: string }
    | { kind: "quiet" };
  occurredAt: Date;
};

export type DashboardDemoConnection = {
  id: string;
  displayName: string;
  authLabel: string;
  changed: string;
};

export type DashboardDemoSignups = {
  plans: readonly { id: string; label: string }[];
  /** One entry per day of the week so far, counting signups per plan. */
  perDay: readonly { day: string; values: Readonly<Record<string, number>> }[];
  recent: readonly { company: string; plan: string; seats: string; when: string }[];
};

const NOW = Date.UTC(2026, 9, 26, 14, 30);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function before(duration: number) {
  return new Date(NOW - duration);
}

export const DASHBOARD_DEMO_STATE: DashboardDemoState = {
  now: NOW,
  scopeLabel: "Acme",
  people: [
    {
      id: "noor",
      initials: "N",
      name: "Noor",
      email: "noor@acme.test",
      activity: "On the Dashboard · now",
    },
    {
      id: "jan",
      initials: "J",
      name: "Jan",
      email: "jan@acme.test",
      activity: "In Agents · 3m ago",
    },
  ],
  attention: [{ workflow: "customer-intake", updatedAt: before(2 * MINUTE) }],
  recentActivity: [
    {
      id: "pull-request",
      title: "pull-request-review",
      trigger: "GitHub · Pull request opened · acme/web#482",
      icon: "share-2",
      outcome: { kind: "running" },
      occurredAt: before(1 * MINUTE),
    },
    {
      id: "telegram",
      title: "Assistant",
      trigger: "Telegram · Message received · Can I change my plan?",
      icon: "message-square",
      outcome: { kind: "quiet" },
      occurredAt: before(4 * MINUTE),
    },
    {
      id: "digest",
      title: "publish-digest",
      trigger: "On schedule · Morning digest",
      icon: "share-2",
      outcome: { kind: "settled", duration: "11.8s" },
      occurredAt: before(6 * HOUR + 30 * MINUTE),
    },
  ],
  connections: [
    {
      id: "google-drive",
      displayName: "Google Drive",
      authLabel: "OAuth",
      changed: "Just now",
    },
    {
      id: "slack",
      displayName: "Slack",
      authLabel: "OAuth",
      changed: "Just now",
    },
    {
      id: "github",
      displayName: "GitHub",
      authLabel: "App installation",
      changed: "Oct 23",
    },
    {
      id: "telegram",
      displayName: "Telegram",
      authLabel: "API key",
      changed: "Oct 21",
    },
  ],
  automatedRun: {
    id: "notify-sales",
    title: "notify-sales",
    trigger: "Stripe · Customer created · Northwind, Business",
    icon: "share-2",
    outcome: { kind: "settled", duration: "1.2s" },
    occurredAt: before(0),
  },
  signups: {
    plans: [
      { id: "starter", label: "Starter" },
      { id: "team", label: "Team" },
      { id: "business", label: "Business" },
    ],
    perDay: [
      { day: "Mon", values: { starter: 9, team: 4, business: 1 } },
      { day: "Tue", values: { starter: 12, team: 6, business: 2 } },
      { day: "Wed", values: { starter: 8, team: 7, business: 1 } },
      { day: "Thu", values: { starter: 14, team: 5, business: 3 } },
    ],
    recent: [
      { company: "Northwind", plan: "Business", seats: "40", when: "12m ago" },
      { company: "Harbor & Co", plan: "Team", seats: "8", when: "1h ago" },
      { company: "Lumen Labs", plan: "Starter", seats: "2", when: "3h ago" },
    ],
  },
};
