import type {
  AutomationRouteDefinition,
  AutomationScheduleCadence,
} from "@fragno-dev/backoffice-api/v0/automation";
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

/** A scheduled route that will fire again, with how often it fires in words. */
export type DashboardSchedule = { routeId: string; name: string; cadence: string; at: Date };

/** The runs of one workflow that wait for an event without asking a person. */
export type DashboardWaitingWorkflow = {
  workflow: string;
  waitingFor: string[];
  runCount: number;
  latestRun: DashboardRunReference;
};

export type BackofficeDashboard = {
  attention: DashboardAttention[];
  /** Soonest first. */
  schedules: DashboardSchedule[];
  /** The workflow that waited last first. */
  waiting: DashboardWaitingWorkflow[];
  bucketStarts: number[];
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

const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

/** A cron day of the week, where both 0 and 7 are Sunday, by name. */
function cronWeekday(field: string): string | null {
  const day = Number(field);
  // 1970-01-04 was a Sunday.
  return Number.isInteger(day) && day >= 0 && day <= 7
    ? weekdayFormat.format(Date.UTC(1970, 0, 4 + (day % 7)))
    : null;
}

/**
 * How often a schedule fires, in words, for the common cron shapes; others keep their expression.
 * Times read in the schedule's own time zone, which the words name.
 */
function describeScheduleCadence(cadence: AutomationScheduleCadence): string {
  if (cadence.kind === "once") {
    return "Once";
  }
  const fields = cadence.expression.trim().split(/\s+/);
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const isNumber = (field: string) => /^\d{1,2}$/.test(field);
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${cadence.timeZone}`;
  const step = /^\*\/(\d+)$/.exec(minute)?.[1];
  const everyDay = dayOfMonth === "*" && month === "*";

  if (fields.length !== 5) {
    return `Cron ${cadence.expression}`;
  }
  if (minute === "*" && hour === "*" && everyDay && dayOfWeek === "*") {
    return "Every minute";
  }
  if (step !== undefined && hour === "*" && everyDay && dayOfWeek === "*") {
    return step === "1" ? "Every minute" : `Every ${step} minutes`;
  }
  if (isNumber(minute) && hour === "*" && everyDay && dayOfWeek === "*") {
    return `Every hour at :${minute.padStart(2, "0")}`;
  }
  if (isNumber(minute) && isNumber(hour) && everyDay) {
    if (dayOfWeek === "*") {
      return `Every day at ${time}`;
    }
    if (dayOfWeek === "1-5") {
      return `Every weekday at ${time}`;
    }
    const weekday = cronWeekday(dayOfWeek);
    if (weekday !== null) {
      return `Every ${weekday} at ${time}`;
    }
  }
  if (
    isNumber(minute) &&
    isNumber(hour) &&
    isNumber(dayOfMonth) &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Monthly on day ${dayOfMonth} at ${time}`;
  }
  return `Cron ${cadence.expression}`;
}

/**
 * Summarizes a scope's synchronized automation state for its overview: what needs a person, which
 * schedules fire next, and which runs wait for an event without asking anyone.
 */
export function projectBackofficeDashboard({
  now,
  runs,
  waitingRuns,
  waits,
  connections,
  routes,
}: {
  now: number;
  runs: readonly DashboardRunRecord[];
  /** Waiting runs in full, as the interface of one that awaits input renders them. */
  waitingRuns: readonly AutomationWorkflowRun[];
  waits: readonly WorkflowWaitRecord[];
  /** The scope's connections that are not disconnected. */
  connections: readonly IntegrationConnectionRecord[];
  routes: readonly AutomationRouteDefinition[];
}): BackofficeDashboard {
  const bucketStarts = dashboardBucketStarts(now);
  const windowStart = bucketStarts[0] ?? now;
  const inWindow = (time: Date | null): time is Date =>
    time !== null && time.getTime() >= windowStart;

  const failingWorkflows: DashboardAttention[] = [];
  for (const [workflow, workflowRuns] of groupBy(runs, workflowDisplayName)) {
    const errored = workflowRuns.filter(
      (run): run is DashboardRunRecord & { completedAt: Date } =>
        run.status === "errored" && inWindow(run.completedAt),
    );
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

  // A waiting run asks a person only when it shows an interface for the events it waits on.
  const awaitingInput: DashboardAttention[] = [];
  const waitingEntries: { run: AutomationWorkflowRun; waitingFor: string[] }[] = [];
  const waitsByRun = groupBy(waits, (wait) => wait.runId);
  for (const run of waitingRuns) {
    const runWaits = waitsByRun.get(run.id) ?? [];
    const interfaceStep = awaitingInputStep(run, runWaits);
    if (interfaceStep) {
      awaitingInput.push({
        kind: "awaiting-input",
        workflow: workflowDisplayName(run),
        run,
        generatedUi: { type: "step", step: interfaceStep },
      });
      continue;
    }
    waitingEntries.push({ run, waitingFor: runWaits.map((wait) => wait.eventType) });
  }
  const waitingByWorkflow = groupBy(waitingEntries, (entry) => workflowDisplayName(entry.run));
  const waiting = [...waitingByWorkflow].map(([workflow, entries]): DashboardWaitingWorkflow => {
    const latest = entries.reduce((last, entry) =>
      entry.run.updatedAt > last.run.updatedAt ? entry : last,
    ).run;
    return {
      workflow,
      waitingFor: [...new Set(entries.flatMap((entry) => entry.waitingFor))].sort(),
      runCount: entries.length,
      latestRun: {
        workflowName: latest.workflowName,
        instanceId: latest.instanceId,
        status: latest.status,
        updatedAt: new Date(latest.updatedAt),
      },
    };
  });
  waiting.sort(
    (left, right) => right.latestRun.updatedAt.getTime() - left.latestRun.updatedAt.getTime(),
  );

  const schedules = routes.flatMap((route): DashboardSchedule[] =>
    route.enabled && route.trigger.kind === "schedule" && route.nextOccurrenceAt
      ? [
          {
            routeId: route.id,
            name: route.name,
            cadence: describeScheduleCadence(route.trigger.cadence),
            at: new Date(route.nextOccurrenceAt),
          },
        ]
      : [],
  );
  schedules.sort((left, right) => left.at.getTime() - right.at.getTime());

  return {
    attention: [
      ...awaitingInput,
      ...failingWorkflows,
      ...connections
        .filter((connection) => connection.state === "unavailable")
        .map((connection): DashboardAttention => ({ kind: "connection-unavailable", connection })),
    ],
    schedules,
    waiting,
    bucketStarts,
  };
}
