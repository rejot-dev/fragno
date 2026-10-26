import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";

import type { WorkflowWaitRecord } from "@/fragno/automation/workflow-waits";
import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import type {
  AutomationWorkflowRun,
  WorkflowRunGeneratedUi,
  WorkflowRunStep,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

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

/** Records stamped by a server clock ahead of this one land in the current bucket. */
export function dashboardBucketIndex(bucketStarts: readonly number[], time: Date): number {
  const windowStart = bucketStarts[0] ?? time.getTime();
  return Math.min(bucketStarts.length - 1, Math.floor((time.getTime() - windowStart) / BUCKET_MS));
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
  | { kind: "connection-unavailable"; connection: IntegrationConnectionRecord };

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
  connections: readonly IntegrationConnectionRecord[];
  upcoming: DashboardUpcoming[];
};

/**
 * The completed step whose interface a waiting run asks a person to answer, or null when the run
 * waits without asking.
 */
export function awaitingInputStep(
  run: AutomationWorkflowRun,
  runWaits: readonly WorkflowWaitRecord[],
): WorkflowRunStep | null {
  const interfaceStepKey = runWaits[0]?.interfaceStepKey ?? null;
  return interfaceStepKey === null
    ? null
    : (run.workflowSteps.find((step) => step.stepKey === interfaceStepKey) ?? null);
}

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
  waits,
  events,
  connections,
  routes,
}: {
  now: number;
  runs: readonly DashboardRunRecord[];
  /** Waiting runs in full, as the interface of one that awaits input renders them. */
  waitingRuns: readonly AutomationWorkflowRun[];
  waits: readonly WorkflowWaitRecord[];
  events: readonly DashboardEventRecord[];
  /** The scope's connections that are not disconnected, in the order the panel lists them. */
  connections: readonly IntegrationConnectionRecord[];
  routes: readonly AutomationRouteDefinition[];
}): BackofficeDashboard {
  const bucketStarts = dashboardBucketStarts(now);
  const windowStart = bucketStarts[0] ?? now;
  const bucketIndex = (time: Date) => dashboardBucketIndex(bucketStarts, time);
  const inWindow = (time: Date | null): time is Date =>
    time !== null && time.getTime() >= windowStart;

  const workflows: DashboardWorkflowHealth[] = [];
  const failingWorkflows: DashboardAttention[] = [];
  for (const [workflow, workflowRuns] of groupBy(runs, workflowDisplayName)) {
    const started = workflowRuns.filter((run) => inWindow(run.createdAt));
    const finished = workflowRuns.filter((run): run is DashboardRunRecord & { completedAt: Date } =>
      inWindow(run.completedAt),
    );
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
    // A workflow whose run completed after its failures has recovered from them. Runs that end
    // in the same instant have no order, so a failure tied with a completion still counts.
    const recoveredAt = workflowRuns.reduce(
      (latest, run) =>
        run.status === "complete" && run.completedAt
          ? Math.max(latest, run.completedAt.getTime())
          : latest,
      -Infinity,
    );
    const unrecovered = errored.filter((run) => run.completedAt.getTime() >= recoveredAt);
    if (unrecovered.length > 0) {
      const latestErrored = latestByUpdate(unrecovered);
      failingWorkflows.push({
        kind: "failing-workflow",
        workflow,
        erroredRuns: unrecovered.length,
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
  const waitsByRun = groupBy(waits, (wait) => wait.runId);
  for (const run of waitingRuns) {
    const runWaits = waitsByRun.get(run.id) ?? [];
    const waitingFor = runWaits.map((wait) => wait.eventType);
    const interfaceStep = awaitingInputStep(run, runWaits);
    if (interfaceStep) {
      awaitingInput.push({
        kind: "awaiting-input",
        workflow: workflowDisplayName(run),
        run,
        generatedUi: { type: "step", step: interfaceStep },
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
