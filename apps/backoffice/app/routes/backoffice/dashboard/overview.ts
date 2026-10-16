import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";

import { eq, gte, type InitialQueryBuilder } from "@tanstack/react-db";

import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import { INTEGRATIONS_EVENT_SOURCE } from "@/fragno/runtime-tools/families/integrations/integration-events";
import {
  currentWorkflowWaitingEventTypes,
  latestWorkflowRunGeneratedUi,
  type AutomationWorkflowRun,
  type WorkflowRunGeneratedUi,
  type WorkflowRunStep,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import {
  currentIntegrationConnections,
  integrationConnectionStateChanges,
  type IntegrationConnectionStateChange,
} from "@/routes/backoffice/integrations/connection-overview";

const HOUR_MS = 60 * 60 * 1000;

/** The dashboard looks back one day, in hourly bars. */
const WINDOW_MS = 24 * HOUR_MS;
const BUCKET_MS = HOUR_MS;

/**
 * Buckets align to whole hours so bars stay put as time passes. The first bucket starts at or
 * before `now` minus a day and the last one holds `now`, so the window covers at least a day.
 */
export function dashboardBucketStarts(now: number): number[] {
  const firstStart = Math.floor((now - WINDOW_MS) / BUCKET_MS) * BUCKET_MS;
  const lastStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  return Array.from(
    { length: (lastStart - firstStart) / BUCKET_MS + 1 },
    (_, index) => firstStart + index * BUCKET_MS,
  );
}

export function dashboardRunsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "workflowInstances">,
) {
  return query.from({ instance: collections.workflowInstances }).select(({ instance }) => ({
    id: instance.id,
    instanceId: instance.instanceId,
    workflowName: instance.workflowName,
    remoteWorkflowName: instance.remoteWorkflowName,
    status: instance.status,
    errorName: instance.errorName,
    errorMessage: instance.errorMessage,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    completedAt: instance.completedAt,
  }));
}

export function dashboardEventsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "events">,
  since: Date,
) {
  return query
    .from({ event: collections.events })
    .where(({ event }) => gte(event.occurredAt, since))
    .select(({ event }) => ({
      source: event.source,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
    }));
}

/** Every connection state change ever reported; the latest one per connection is its state. */
export function dashboardConnectionEventsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "events">,
) {
  return query
    .from({ event: collections.events })
    .where(({ event }) => eq(event.source, INTEGRATIONS_EVENT_SOURCE))
    .select(({ event }) => ({
      id: event.id,
      source: event.source,
      eventType: event.eventType,
      payload: event.payload,
      subject: event.subject,
      occurredAt: event.occurredAt,
    }));
}

type DashboardRunRecord = {
  id: string;
  instanceId: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  status: string;
  errorName: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type DashboardEventRecord = { source: string; eventType: string; occurredAt: Date };

type DashboardConnectionEventRecord = DashboardEventRecord & {
  id: string;
  payload: unknown;
  subject: unknown;
};

/** The run a dashboard row opens. */
export type DashboardRunReference = {
  workflowName: string;
  instanceId: string;
  status: WorkflowInstanceStatus;
  updatedAt: Date;
};

export type DashboardAttention =
  | {
      kind: "awaiting-input";
      workflow: string;
      run: AutomationWorkflowRun;
      generatedUi: Extract<WorkflowRunGeneratedUi<WorkflowRunStep>, { type: "step" }>;
    }
  | {
      kind: "failing-workflow";
      workflow: string;
      erroredRuns: number;
      latestRun: DashboardRunReference;
      error: string | null;
    }
  | { kind: "connection-unavailable"; connection: IntegrationConnectionStateChange };

export type DashboardWorkflowHealth = {
  workflow: string;
  startedRuns: number;
  completedRuns: number;
  erroredRuns: number;
  startsPerBucket: number[];
  latestRun: DashboardRunReference;
};

export type DashboardUpcoming =
  | { kind: "schedule"; routeId: string; name: string; at: Date }
  | {
      kind: "waiting-run";
      workflow: string;
      run: DashboardRunReference;
      waitingFor: readonly string[];
    };

export type BackofficeDashboard = {
  attention: DashboardAttention[];
  workflows: DashboardWorkflowHealth[];
  eventVolume: {
    bucketStarts: number[];
    sources: { source: string; count: number }[];
    countsByBucket: Record<string, number>[];
  };
  connections: IntegrationConnectionStateChange[];
  upcoming: DashboardUpcoming[];
};

function workflowDisplayName(run: { workflowName: string; remoteWorkflowName: string | null }) {
  return run.remoteWorkflowName ?? run.workflowName;
}

function runReference(run: DashboardRunRecord): DashboardRunReference {
  return {
    workflowName: run.workflowName,
    instanceId: run.instanceId,
    // The workflow schema stores status as a string; the runner persists only its own states.
    status: run.status as WorkflowInstanceStatus,
    updatedAt: run.updatedAt,
  };
}

function runErrorText({ errorName, errorMessage }: DashboardRunRecord): string | null {
  return errorName && errorMessage ? `${errorName}: ${errorMessage}` : (errorName ?? errorMessage);
}

function latestByUpdate(runs: readonly DashboardRunRecord[]): DashboardRunRecord {
  return runs.reduce((latest, run) => (run.updatedAt > latest.updatedAt ? run : latest));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) {
      group.push(item);
    } else {
      groups.set(key(item), [item]);
    }
  }
  return groups;
}

/**
 * Summarizes a scope's synchronized automation state over the last day: what needs a person, how
 * each workflow is doing, what events arrive and which of them nothing handles, and what is
 * scheduled or waiting next.
 */
export function projectBackofficeDashboard({
  now,
  runs,
  waitingRuns,
  events,
  connectionEvents,
  routes,
}: {
  now: number;
  runs: readonly DashboardRunRecord[];
  waitingRuns: readonly AutomationWorkflowRun[];
  events: readonly DashboardEventRecord[];
  connectionEvents: readonly DashboardConnectionEventRecord[];
  routes: readonly AutomationRouteDefinition[];
}): BackofficeDashboard {
  const bucketStarts = dashboardBucketStarts(now);
  const windowStart = bucketStarts[0] ?? now;
  // Records stamped by a server clock ahead of this one land in the current bucket.
  const bucketIndex = (time: Date) =>
    Math.min(bucketStarts.length - 1, Math.floor((time.getTime() - windowStart) / BUCKET_MS));
  const inWindow = (time: Date | null): time is Date =>
    time !== null && time.getTime() >= windowStart;

  const workflows: DashboardWorkflowHealth[] = [];
  const failingWorkflows: DashboardAttention[] = [];
  for (const [workflow, workflowRuns] of groupBy(runs, workflowDisplayName)) {
    const started = workflowRuns.filter((run) => inWindow(run.createdAt));
    const finished = workflowRuns.filter((run) => inWindow(run.completedAt));
    const errored = finished.filter((run) => run.status === "errored");
    const startsPerBucket = bucketStarts.map(() => 0);
    for (const run of started) {
      startsPerBucket[bucketIndex(run.createdAt)] += 1;
    }
    workflows.push({
      workflow,
      startedRuns: started.length,
      completedRuns: finished.filter((run) => run.status === "complete").length,
      erroredRuns: errored.length,
      startsPerBucket,
      latestRun: runReference(latestByUpdate(workflowRuns)),
    });
    if (errored.length > 0) {
      const latestErrored = latestByUpdate(errored);
      failingWorkflows.push({
        kind: "failing-workflow",
        workflow,
        erroredRuns: errored.length,
        latestRun: runReference(latestErrored),
        error: runErrorText(latestErrored),
      });
    }
  }
  workflows.sort(
    (left, right) => right.latestRun.updatedAt.getTime() - left.latestRun.updatedAt.getTime(),
  );

  // A waiting run asks a person only when it shows an interface for the events it waits on.
  const awaitingInput: DashboardAttention[] = [];
  const upcoming: DashboardUpcoming[] = [];
  for (const run of waitingRuns) {
    const waitingFor = currentWorkflowWaitingEventTypes(run.workflowSteps);
    const generatedUi = latestWorkflowRunGeneratedUi({
      output: run.output,
      steps: run.workflowSteps,
    });
    if (generatedUi?.type === "step" && waitingFor.length > 0) {
      awaitingInput.push({
        kind: "awaiting-input",
        workflow: workflowDisplayName(run),
        run,
        generatedUi,
      });
    } else {
      upcoming.push({
        kind: "waiting-run",
        workflow: workflowDisplayName(run),
        run: {
          workflowName: run.workflowName,
          instanceId: run.instanceId,
          status: run.status,
          updatedAt: new Date(run.updatedAt),
        },
        waitingFor,
      });
    }
  }
  for (const route of routes) {
    if (route.enabled && route.trigger.kind === "schedule" && route.nextOccurrenceAt) {
      upcoming.push({
        kind: "schedule",
        routeId: route.id,
        name: route.name,
        at: new Date(route.nextOccurrenceAt),
      });
    }
  }
  const upcomingTime = (entry: DashboardUpcoming) =>
    entry.kind === "schedule" ? entry.at.getTime() : entry.run.updatedAt.getTime();
  upcoming.sort((left, right) => upcomingTime(left) - upcomingTime(right));

  const connections = currentIntegrationConnections(
    integrationConnectionStateChanges(connectionEvents),
  ).filter((connection) => connection.state !== "disconnected");

  const windowEvents = events.filter((event) => inWindow(event.occurredAt));
  const countsByBucket = bucketStarts.map((): Record<string, number> => ({}));
  for (const event of windowEvents) {
    const counts = countsByBucket[bucketIndex(event.occurredAt)];
    counts[event.source] = (counts[event.source] ?? 0) + 1;
  }
  const sourceCounts = [...groupBy(windowEvents, (event) => event.source)]
    .map(([source, sourceEvents]) => ({ source, count: sourceEvents.length }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));

  return {
    attention: [
      ...awaitingInput,
      ...failingWorkflows,
      ...connections
        .filter((connection) => connection.state === "unavailable")
        .map((connection): DashboardAttention => ({ kind: "connection-unavailable", connection })),
    ],
    workflows,
    eventVolume: {
      bucketStarts,
      sources: sourceCounts,
      countsByBucket,
    },
    connections,
    upcoming,
  };
}
