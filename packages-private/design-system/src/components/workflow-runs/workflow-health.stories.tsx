import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  WorkflowHealth,
  type WorkflowHealthFilter,
  type WorkflowHealthPaths,
  type WorkflowHealthRun,
  type WorkflowHealthRunStep,
} from "./workflow-health";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import type { WorkflowRunNode } from "./workflow-run-timeline-model";

export default { title: "Workflow runs/Workflow health" };

const NOW = Date.UTC(2026, 10, 10, 12, 40, 0);
const MINUTE = 60_000;

// Seeded, so every story renders the same runs on every load.
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A step of a fixture workflow: how often one attempt fails, and how many attempts it gets. */
type FixtureStep = {
  name: string;
  failRate: number;
  attempts: number;
  error: string;
  seconds: number;
};

type FixtureStepOutcome = Omit<WorkflowHealthRunStep, "id">;

type FixtureOutcome = { steps: FixtureStepOutcome[]; error: string | null; seconds: number };

/** Runs the steps in order until one exhausts its attempts. */
function runSteps(steps: readonly FixtureStep[], random: () => number): FixtureOutcome {
  const ran: FixtureStepOutcome[] = [];
  let seconds = 0;
  for (const step of steps) {
    let attempts = 0;
    let succeeded = false;
    while (attempts < step.attempts && !succeeded) {
      attempts += 1;
      seconds += step.seconds;
      succeeded = random() >= step.failRate;
    }
    ran.push({ name: step.name, status: succeeded ? "completed" : "failed", attempts });
    if (!succeeded) {
      return { steps: ran, error: step.error, seconds };
    }
  }
  return { steps: ran, error: null, seconds };
}

function fixtureRuns({
  workflow,
  count,
  everyMinutes,
  seed,
  attempt,
}: {
  workflow: string;
  count: number;
  everyMinutes: number;
  seed: number;
  attempt: (random: () => number) => FixtureOutcome;
}): WorkflowHealthRun[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, index): WorkflowHealthRun => {
    const startedAt = NOW - (index + 1) * everyMinutes * MINUTE;
    const id = `${workflow}-schedule-${startedAt}`;
    const outcome = attempt(random);
    const steps = outcome.steps.map((step, stepIndex) => ({ ...step, id: `${id}:${stepIndex}` }));
    const base = { id, trigger: "On schedule", startedAt, steps };
    const endedAt = startedAt + outcome.seconds * 1000;
    return outcome.error === null
      ? { ...base, status: "complete", endedAt }
      : {
          ...base,
          status: "errored",
          endedAt,
          error: outcome.error,
          // The fixtures stop at the step that failed; with every step completed, the run failed after them.
          failedStepId: steps.at(-1)?.status === "failed" ? (steps.at(-1)?.id ?? null) : null,
        };
  });
}

const invoiceSyncSteps: FixtureStep[] = [
  { name: "fetch open invoices", failRate: 0, attempts: 1, error: "", seconds: 0.3 },
  { name: "normalize line items", failRate: 0, attempts: 1, error: "", seconds: 0.1 },
  { name: "respect ledger rate limit", failRate: 0, attempts: 1, error: "", seconds: 3 },
  {
    name: "post to ledger",
    failRate: 0.6,
    attempts: 3,
    error: "Ledger API returned 503 Service Unavailable for batch of 6",
    seconds: 1.4,
  },
  { name: "summarize sync", failRate: 0, attempts: 1, error: "", seconds: 0.1 },
];

const WAREHOUSES = ["AMS-1", "RTM-2", "BER-1", "PAR-3", "MAD-1"];

const inventorySteps: FixtureStep[] = [
  ...WAREHOUSES.map((warehouse) => ({
    name: `reconcile ${warehouse}`,
    failRate: 0.25,
    attempts: 2,
    error: `Timed out after 30000ms waiting for ${warehouse} stock snapshot`,
    seconds: 0.6,
  })),
  { name: "let downstream caches settle", failRate: 0, attempts: 1, error: "", seconds: 2 },
  { name: "publish reconciliation", failRate: 0, attempts: 1, error: "", seconds: 0.2 },
];

function refundReview(random: () => number): FixtureOutcome {
  const intake = runSteps(
    [
      { name: "load refund request", failRate: 0, attempts: 1, error: "", seconds: 0.2 },
      { name: "score fraud risk", failRate: 0, attempts: 1, error: "", seconds: 0.3 },
    ],
    random,
  );
  // Large or risky refunds wait for an approval that, in this fixture, never comes.
  if (random() < 0.45) {
    return {
      steps: [
        ...intake.steps,
        { name: "wait for manager approval", status: "failed", attempts: 1 },
      ],
      error: "WAIT_FOR_EVENT_TIMEOUT",
      seconds: intake.seconds + 20,
    };
  }
  return {
    steps: [...intake.steps, { name: "issue refund", status: "completed", attempts: 1 }],
    error: null,
    seconds: intake.seconds + 0.3,
  };
}

const dailyReportSteps: FixtureStep[] = [
  { name: "collect metrics", failRate: 0, attempts: 1, error: "", seconds: 0.4 },
  { name: "collect revenue", failRate: 0, attempts: 1, error: "", seconds: 0.5 },
  {
    name: "render report",
    failRate: 0.25,
    attempts: 1,
    error: "Template variable `revenue.previousPeriod` is undefined",
    seconds: 0.6,
  },
  { name: "deliver report", failRate: 0, attempts: 1, error: "", seconds: 0.3 },
];

// The view's state lives in the URL, as it would in Backoffice: `show` and `at` filter the runs,
// `run` opens one, and `runStep` selects a step of it.
function filterFromSearch(search: URLSearchParams): WorkflowHealthFilter {
  const show = search.get("show");
  if (show === "failed") {
    return { kind: "failed" };
  }
  if (show === "step") {
    return { kind: "step", step: search.get("at") };
  }
  return { kind: "all" };
}

function withParams(search: URLSearchParams, params: Record<string, string | null>): string {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return `?${next.toString()}`;
}

function filterParams(filter: WorkflowHealthFilter): Record<string, string | null> {
  switch (filter.kind) {
    case "all":
      return { show: null, at: null };
    case "failed":
      return { show: "failed", at: null };
    case "step":
      return { show: "step", at: filter.step };
  }
  throw new Error("Unsupported workflow health filter.");
}

function runEnd(run: WorkflowHealthRun): number | null {
  switch (run.status) {
    case "active":
    case "waiting":
    case "paused":
      return null;
    case "complete":
    case "terminated":
    case "errored":
      return run.endedAt;
  }
  throw new Error("Unsupported workflow run status.");
}

/** The run's steps on the run timeline, spread over the run's span: the fixtures keep no timings. */
function timelineNodes(run: WorkflowHealthRun): WorkflowRunNode[] {
  const endedAt = runEnd(run);
  const span = (endedAt ?? NOW) - run.startedAt;
  const at = (index: number) => run.startedAt + (span * index) / run.steps.length;
  return run.steps.map(
    (step, index): WorkflowRunNode => ({
      kind: "step",
      step: {
        id: step.id,
        label: step.name,
        detail: run.status === "errored" && step.id === run.failedStepId ? run.error : null,
        status: step.status,
        activity: step.name.startsWith("wait") ? "wait" : "work",
        attempts: { count: step.attempts, max: step.attempts },
        timing: {
          kind: "span",
          startedAt: at(index),
          endedAt: index === run.steps.length - 1 && endedAt === null ? null : at(index + 1),
        },
        children: [],
        iterations: [],
      },
    }),
  );
}

function OpenedRunView({ run, name }: { run: WorkflowHealthRun; name: string }) {
  const [search, setSearch] = useSearchParams();
  const selectedStepId = search.get("runStep");
  return (
    <div className="flex flex-col gap-4">
      <WorkflowRunTimeline
        title={name}
        status={run.status}
        trigger={run.trigger}
        createdAt={run.startedAt}
        startedAt={run.startedAt}
        endedAt={runEnd(run)}
        nodes={timelineNodes(run)}
        events={[]}
        selectedStepId={selectedStepId}
        onSelectStep={(stepId) => {
          setSearch(withParams(search, { runStep: stepId === selectedStepId ? null : stepId }));
        }}
        presentation={{ kind: "standalone", meta: null, actions: null, surface: "flush" }}
      />
      {run.status === "errored" ? (
        <pre className="border border-[color:var(--bo-failed)]/30 bg-[var(--bo-failed-bg)] p-3 font-mono text-xs whitespace-pre-wrap text-[var(--bo-failed)]">
          {run.error}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * The view as Backoffice would mount it, over the URL of the story's router. `initialSearch`
 * starts the story with a filter or a run open.
 */
function Story({
  name,
  description,
  runs,
  initialSearch,
  className,
}: {
  name: string;
  description: string;
  runs: WorkflowHealthRun[];
  initialSearch: string | null;
  className: string;
}) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const started = useRef(false);
  useEffect(() => {
    if (!started.current && initialSearch !== null) {
      started.current = true;
      void navigate(initialSearch, { replace: true });
    }
  }, [initialSearch, navigate]);

  const opened = runs.find((run) => run.id === search.get("run")) ?? null;
  const paths: WorkflowHealthPaths = {
    filter: (filter) => withParams(search, filterParams(filter)),
    run: (runId, stepId) => withParams(search, { run: runId, runStep: stepId }),
    close: withParams(search, { run: null, runStep: null }),
  };
  return (
    <div className={className}>
      <WorkflowHealth
        name={name}
        description={description}
        runs={runs}
        filter={filterFromSearch(search)}
        openedRun={
          opened === null
            ? null
            : { id: opened.id, view: <OpenedRunView run={opened} name={name} /> }
        }
        paths={paths}
        now={NOW}
      />
    </div>
  );
}

const WIDE = "mx-auto max-w-5xl";

const invoiceSyncRuns = fixtureRuns({
  workflow: "invoice-sync",
  count: 48,
  everyMinutes: 5,
  seed: 7,
  attempt: (random) => runSteps(invoiceSyncSteps, random),
});

/** Opens invoice-sync's latest failure from the failures at its failing step. */
function openedFailureSearch(): string {
  const run = invoiceSyncRuns.find((candidate) => candidate.status === "errored");
  const step = run?.steps.find((candidate) => candidate.status === "failed");
  return `?${new URLSearchParams({
    show: "step",
    at: "post to ledger",
    run: run?.id ?? "",
    runStep: step?.id ?? "",
  }).toString()}`;
}

/** Most failures sit at one step, and many runs only complete because a retry rescued them. */
export function RetriedStep() {
  return (
    <Story
      name="invoice-sync"
      description="Every 5 minutes · /workspace/automations/invoice-sync.workflow.js"
      runs={invoiceSyncRuns}
      initialSearch={null}
      className={WIDE}
    />
  );
}

/**
 * Opened from the failures at one step: the run opens on the step it failed at, and the arrows
 * walk the other runs that failed there. On a wide page the run sits beside the lists.
 */
export function OpenedFailure() {
  return (
    <Story
      name="invoice-sync"
      description="Every 5 minutes · /workspace/automations/invoice-sync.workflow.js"
      runs={invoiceSyncRuns}
      initialSearch={openedFailureSearch()}
      className="mx-auto max-w-[96rem]"
    />
  );
}

/** The same opened run where the page is too narrow to hold it beside the lists. */
export function OpenedFailureStacked() {
  return (
    <Story
      name="invoice-sync"
      description="Every 5 minutes · /workspace/automations/invoice-sync.workflow.js"
      runs={invoiceSyncRuns}
      initialSearch={openedFailureSearch()}
      className={WIDE}
    />
  );
}

/** Failures spread over several steps that share a cause. */
export function FailuresAcrossSteps() {
  return (
    <Story
      name="inventory-reconcile"
      description="Every 15 minutes · /workspace/automations/inventory-reconcile.workflow.js"
      runs={fixtureRuns({
        workflow: "inventory-reconcile",
        count: 32,
        everyMinutes: 15,
        seed: 11,
        attempt: (random) => runSteps(inventorySteps, random),
      })}
      initialSearch={null}
      className={WIDE}
    />
  );
}

/** Runs take different branches, so steps are reached a different number of times. */
export function Branches() {
  return (
    <Story
      name="refund-review"
      description="Every 7 minutes · /workspace/automations/refund-review.workflow.js"
      runs={fixtureRuns({
        workflow: "refund-review",
        count: 40,
        everyMinutes: 7,
        seed: 3,
        attempt: refundReview,
      })}
      initialSearch={null}
      className={WIDE}
    />
  );
}

/** A step without retries fails its run outright. */
export function NoRetries() {
  return (
    <Story
      name="daily-report"
      description="Every 10 minutes · /workspace/automations/daily-report.workflow.js"
      runs={fixtureRuns({
        workflow: "daily-report",
        count: 36,
        everyMinutes: 10,
        seed: 5,
        attempt: (random) => runSteps(dailyReportSteps, random),
      })}
      initialSearch={null}
      className={WIDE}
    />
  );
}

export function Healthy() {
  return (
    <Story
      name="daily-report"
      description="Every 10 minutes · /workspace/automations/daily-report.workflow.js"
      runs={fixtureRuns({
        workflow: "daily-report",
        count: 24,
        everyMinutes: 10,
        seed: 5,
        attempt: (random) =>
          runSteps(
            dailyReportSteps.map((step) => ({ ...step, failRate: 0 })),
            random,
          ),
      })}
      initialSearch={null}
      className={WIDE}
    />
  );
}

/** The latest run is still going, waiting at its current step; one older run was terminated. */
export function InProgress() {
  const [first, second, ...rest] = fixtureRuns({
    workflow: "refund-review",
    count: 20,
    everyMinutes: 7,
    seed: 9,
    attempt: refundReview,
  });
  const runs: WorkflowHealthRun[] = [];
  if (first !== undefined && second !== undefined) {
    runs.push(
      {
        id: first.id,
        trigger: first.trigger,
        startedAt: NOW - 8_000,
        status: "waiting",
        steps: [
          { id: `${first.id}:0`, name: "load refund request", status: "completed", attempts: 1 },
          { id: `${first.id}:1`, name: "score fraud risk", status: "completed", attempts: 1 },
          {
            id: `${first.id}:2`,
            name: "wait for manager approval",
            status: "waiting",
            attempts: 0,
          },
        ],
      },
      {
        id: second.id,
        trigger: "Manual",
        startedAt: second.startedAt,
        status: "terminated",
        endedAt: second.startedAt + 4 * MINUTE,
        steps: second.steps.slice(0, 2),
      },
    );
  }
  return (
    <Story
      name="refund-review"
      description="Every 7 minutes · /workspace/automations/refund-review.workflow.js"
      runs={[...runs, ...rest]}
      initialSearch={null}
      className={WIDE}
    />
  );
}

export function NoRuns() {
  return (
    <Story
      name="weekly-digest"
      description="Mondays at 09:00 · /workspace/automations/weekly-digest.workflow.js"
      runs={[]}
      initialSearch={null}
      className={WIDE}
    />
  );
}

/** In a narrow column, such as beside a list of workflows. */
export function Narrow() {
  return (
    <Story
      name="invoice-sync"
      description="Every 5 minutes · /workspace/automations/invoice-sync.workflow.js"
      runs={invoiceSyncRuns}
      initialSearch={null}
      className="max-w-md"
    />
  );
}
