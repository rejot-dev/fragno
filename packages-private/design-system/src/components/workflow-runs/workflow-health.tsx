import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../../cn";
import { Metric } from "../data/metric";
import { formatRelativeTime } from "../data/relative-time";
import { BackofficeStatusLight } from "../feedback/status-light";
import type { BackofficeStatusTone } from "../feedback/status-tone";
import { Icon } from "../icon";
import { PanelTable, PanelTableRow, type PanelTableColumn } from "../layout/panel";
import { underlineTabClassName } from "../navigation/underline-tab-class-name";
import { formatWorkflowDuration, type WorkflowRunStepStatus } from "./workflow-run-timeline-model";

/** One step of a run, as far as the run got: a step it never reached is not listed. */
export type WorkflowHealthRunStep = {
  /** The step's record, which a run's view selects. */
  id: string;
  name: string;
  status: WorkflowRunStepStatus;
  attempts: number;
};

/** One run of the workflow, with the steps it reached in the order it reached them. */
export type WorkflowHealthRun = {
  id: string;
  /** What started the run, in words, such as "On schedule". */
  trigger: string;
  startedAt: number;
  steps: readonly WorkflowHealthRunStep[];
} & (
  | { status: "active" | "waiting" | "paused" }
  | { status: "complete" | "terminated"; endedAt: number }
  | {
      status: "errored";
      endedAt: number;
      error: string;
      /**
       * The step whose failure ended the run; null when it failed outside every step. A run can
       * catch a step's failure and go on, so this need not be the first failed step.
       */
      failedStepId: string | null;
    }
);

type ErroredRun = Extract<WorkflowHealthRun, { status: "errored" }>;

/** Which runs the list shows; `step` names the step the runs failed at, null for outside every step. */
export type WorkflowHealthFilter =
  | { kind: "all" }
  | { kind: "failed" }
  | { kind: "step"; step: string | null };

/**
 * Where each control leads. The view keeps no navigation of its own, so the filter and the opened
 * run live in the URL: they survive a reload, and Back returns to them. Its links keep the scroll
 * position, because they change what the view shows, not the page.
 */
export type WorkflowHealthPaths = {
  filter: (filter: WorkflowHealthFilter) => string;
  /** The run opened, on `stepId` when one is named. */
  run: (runId: string, stepId: string | null) => string;
  /** No run opened. */
  close: string;
};

// A failure outside every step, such as a throw between steps, still needs a row to count under.
const OUTSIDE_STEPS = "Outside any step";
const STRIP_RUNS = 90;
const LISTED_RUNS = 20;

/**
 * How one workflow has been doing across its runs: how often it fails, at which steps and why,
 * which runs only completed because a retry rescued them, and each run, which opens beside the
 * lists as `openedRun`. `runs` are newest first.
 */
export function WorkflowHealth({
  name,
  description,
  runs,
  filter,
  openedRun,
  paths,
  now,
}: {
  name: string;
  /** A line under the name, such as the workflow's schedule and file. */
  description: string;
  runs: readonly WorkflowHealthRun[];
  filter: WorkflowHealthFilter;
  /** The opened run's view, such as its step timeline. */
  openedRun: { id: string; view: ReactNode } | null;
  paths: WorkflowHealthPaths;
  now: number;
}) {
  const [showAllRuns, setShowAllRuns] = useState(false);
  const openedRef = useRef<HTMLDivElement>(null);
  const openedId = openedRun?.id ?? null;
  // A run opens from links anywhere in the view, so bring it into view where it stacks below them.
  useEffect(() => {
    if (openedId !== null) {
      openedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [openedId]);

  const latest = runs[0];
  const failed = runs.filter((run) => run.status === "errored");
  const filtered = runs.filter((run) => matchesFilter(run, filter));
  const listed = showAllRuns ? filtered : filtered.slice(0, LISTED_RUNS);
  const filterTab = (tab: WorkflowHealthFilter, label: ReactNode) => {
    const selected = tab.kind === filter.kind;
    return (
      <Link
        preventScrollReset
        to={paths.filter(tab)}
        aria-current={selected ? "true" : undefined}
        className={underlineTabClassName(selected ? "selected" : "idle")}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="@container flex min-w-0 flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-[var(--bo-fg)]">{name}</h2>
          <p className="truncate text-xs text-[var(--bo-muted-2)]">{description}</p>
        </div>
        {latest === undefined ? null : (
          <span className="flex items-center gap-2 text-xs text-[var(--bo-muted-2)]">
            Latest run
            <WorkflowRunStatusLight status={latest.status} />
          </span>
        )}
      </header>

      {latest === undefined ? (
        <p className="text-sm text-[var(--bo-muted)]">
          This workflow has not run yet. Its runs appear here as they start.
        </p>
      ) : (
        <>
          <HealthFigures runs={runs} now={now} />
          <RunStrip runs={runs.slice(0, STRIP_RUNS)} openedId={openedId} paths={paths} now={now} />
          <div
            className={cn(
              "grid min-w-0 items-start gap-8",
              openedRun !== null && "@6xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]",
            )}
          >
            {openedRun === null ? null : (
              <div
                ref={openedRef}
                className="min-w-0 scroll-mt-4 @6xl:sticky @6xl:top-4 @6xl:order-last"
              >
                <OpenedRun
                  opened={openedRun}
                  runs={runs}
                  filtered={filtered}
                  filter={filter}
                  paths={paths}
                  now={now}
                />
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-8">
              <StepTable runs={runs} paths={paths} />
              <section aria-label="Runs" className="flex min-w-0 flex-col gap-2">
                <nav
                  aria-label="Which runs to show"
                  className="flex flex-wrap items-stretch gap-4 shadow-[inset_0_-1px_0_var(--bo-border)]"
                >
                  {filterTab(
                    { kind: "all" },
                    <>
                      All runs <Count value={runs.length} />
                    </>,
                  )}
                  {filterTab(
                    { kind: "failed" },
                    <>
                      Failed <Count value={failed.length} />
                    </>,
                  )}
                  {filter.kind === "step" ? (
                    <Link
                      preventScrollReset
                      to={paths.filter({ kind: "all" })}
                      aria-current="true"
                      aria-label={`Showing failures at ${filter.step ?? OUTSIDE_STEPS}; show all runs`}
                      className={underlineTabClassName("selected")}
                    >
                      Failed at {filter.step ?? OUTSIDE_STEPS} <Count value={filtered.length} />
                      <Icon name="x" className="text-[var(--bo-muted-2)]" />
                    </Link>
                  ) : null}
                </nav>
                <RunTable
                  runs={listed}
                  hiddenCount={filtered.length - listed.length}
                  onShowAll={() => setShowAllRuns(true)}
                  openedId={openedId}
                  paths={paths}
                  now={now}
                />
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function matchesFilter(run: WorkflowHealthRun, filter: WorkflowHealthFilter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "failed":
      return run.status === "errored";
    case "step":
      return run.status === "errored" && failedStep(run) === filter.step;
  }
}

/** The step a failed run stopped at; null when it failed outside every step. */
function failedStep(run: ErroredRun): string | null {
  return run.steps.find((step) => step.id === run.failedStepId)?.name ?? null;
}

/**
 * The step a run's link opens on: the one it failed at, else the first a retry rescued. A run that
 * failed outside every step opens on its outcome.
 */
function focusStep(run: WorkflowHealthRun): WorkflowHealthRunStep | null {
  if (run.status === "errored") {
    return run.steps.find((step) => step.id === run.failedStepId) ?? null;
  }
  return run.steps.find((step) => step.status === "completed" && step.attempts > 1) ?? null;
}

function runPath(run: WorkflowHealthRun, paths: WorkflowHealthPaths): string {
  return paths.run(run.id, focusStep(run)?.id ?? null);
}

/** Steps that took more than one attempt and still completed. */
function rescuedSteps(run: WorkflowHealthRun): string[] {
  return run.steps
    .filter((step) => step.status === "completed" && step.attempts > 1)
    .map((step) => step.name);
}

function isRescued(run: WorkflowHealthRun): boolean {
  return run.status === "complete" && rescuedSteps(run).length > 0;
}

function runDuration(run: WorkflowHealthRun): number | null {
  return run.status === "complete" || run.status === "terminated" || run.status === "errored"
    ? run.endedAt - run.startedAt
    : null;
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return null;
  }
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

/** A run's start as a clock time, with its day when it started on another day than `now`. */
function formatStart(at: number, now: number): string {
  const start = new Date(at);
  const sameDay = start.toDateString() === new Date(now).toDateString();
  return start.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Count({ value }: { value: number }) {
  return <span className="font-normal text-[var(--bo-muted-2)] tabular-nums">{value}</span>;
}

function HealthFigures({ runs, now }: { runs: readonly WorkflowHealthRun[]; now: number }) {
  const finished = runs.filter((run) => runDuration(run) !== null);
  const failed = runs.filter((run) => run.status === "errored").length;
  const rescued = runs.filter(isRescued).length;
  const completed = runs.filter((run) => run.status === "complete");
  const typical = median(completed.flatMap((run) => runDuration(run) ?? []));
  const oldest = runs.at(-1);

  return (
    <div className="grid grid-cols-2 gap-6 @2xl:grid-cols-4">
      <Metric
        tone={null}
        label="Runs"
        value={String(runs.length)}
        detail={
          oldest === undefined ? "" : `Since ${formatRelativeTime(new Date(oldest.startedAt), now)}`
        }
      />
      <Metric
        tone={failed === 0 ? null : "failed"}
        label="Failed"
        value={String(failed)}
        detail={`${percent(failed, finished.length)} of finished runs`}
      />
      <Metric
        tone={rescued === 0 ? null : "waiting"}
        label="Rescued by a retry"
        value={String(rescued)}
        detail="Completed after a step failed and was retried"
      />
      <Metric
        tone={null}
        label="Typical duration"
        value={typical === null ? "—" : formatWorkflowDuration(typical, "fine")}
        detail="Median of completed runs"
      />
    </div>
  );
}

type RunStripTone = "complete" | "rescued" | "failed" | "progress" | "stopped";

const STRIP_TONES: Record<RunStripTone, { label: string; className: string }> = {
  complete: { label: "Completed", className: "bg-[var(--bo-live)]" },
  rescued: {
    label: "Completed after a retry",
    className: "bg-[var(--bo-live)] shadow-[inset_0_4px_0_var(--bo-waiting)]",
  },
  failed: { label: "Failed", className: "bg-[var(--bo-failed)]" },
  progress: { label: "In progress", className: "bg-[var(--bo-blue-3)]" },
  stopped: { label: "Terminated", className: "bg-[var(--bo-muted-2)]" },
};

function stripTone(run: WorkflowHealthRun): RunStripTone {
  switch (run.status) {
    case "complete":
      return isRescued(run) ? "rescued" : "complete";
    case "errored":
      return "failed";
    case "terminated":
      return "stopped";
    case "active":
    case "waiting":
    case "paused":
      return "progress";
  }
}

/** The latest runs as a row of ticks, oldest on the left, each leading to its run. */
function RunStrip({
  runs,
  openedId,
  paths,
  now,
}: {
  runs: readonly WorkflowHealthRun[];
  openedId: string | null;
  paths: WorkflowHealthPaths;
  now: number;
}) {
  const ordered = [...runs].reverse();
  const oldest = ordered[0];
  const newest = ordered.at(-1);
  const shown = new Set(ordered.map(stripTone));

  return (
    <section aria-label="Latest runs" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-9 items-end gap-[2px]">
        {ordered.map((run) => {
          const tone = stripTone(run);
          const label = `${STRIP_TONES[tone].label} · ${formatRelativeTime(new Date(run.startedAt), now)}${run.status === "errored" ? ` · ${run.error}` : ""}`;
          return (
            <Link
              preventScrollReset
              key={run.id}
              to={runPath(run, paths)}
              aria-label={label}
              aria-current={run.id === openedId ? "true" : undefined}
              title={label}
              className={cn(
                "h-[calc(100%-6px)] max-w-3 min-w-[3px] flex-1 rounded-[1px] opacity-90 transition-[opacity,height] duration-100 hover:h-full hover:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--bo-accent)] aria-[current]:h-full aria-[current]:opacity-100 aria-[current]:outline-2 aria-[current]:outline-offset-1 aria-[current]:outline-[var(--bo-fg)]",
                STRIP_TONES[tone].className,
              )}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-[11px] text-[var(--bo-muted-2)]">
        <span className="tabular-nums">
          {oldest === undefined || newest === undefined
            ? null
            : `${formatRelativeTime(new Date(oldest.startedAt), now)} – ${formatRelativeTime(new Date(newest.startedAt), now)}`}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(Object.keys(STRIP_TONES) as RunStripTone[])
            .filter((tone) => shown.has(tone))
            .map((tone) => (
              <span key={tone} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn("h-2.5 w-1.5 rounded-[1px]", STRIP_TONES[tone].className)}
                />
                {STRIP_TONES[tone].label}
              </span>
            ))}
        </span>
      </div>
    </section>
  );
}

type StepHealth = {
  name: string;
  /** Null for failures outside every step. */
  step: string | null;
  reached: number;
  failed: number;
  rescued: number;
  latestError: string | null;
};

/**
 * Every step any run reached, in workflow order. Runs take different branches, so a step first seen
 * in an older run goes right after the step it followed there.
 */
function stepHealth(runs: readonly WorkflowHealthRun[]): StepHealth[] {
  const order: string[] = [];
  const ordered = new Set<string>();
  for (const run of runs) {
    run.steps.forEach((step, index) => {
      if (ordered.has(step.name)) {
        return;
      }
      ordered.add(step.name);
      const previous = index === 0 ? -1 : order.indexOf(run.steps[index - 1]?.name ?? "");
      order.splice(previous + 1, 0, step.name);
    });
  }

  const health = new Map<string | null, StepHealth>(
    order.map((name) => [
      name,
      { name, step: name, reached: 0, failed: 0, rescued: 0, latestError: null },
    ]),
  );
  // Runs are newest first, so the first error each step sees is its latest.
  for (const run of runs) {
    // A step in a loop runs once each time around, but a run reaches it, or is rescued at it, once.
    const reached = new Set(run.steps.map((step) => step.name));
    const rescued = new Set(rescuedSteps(run));
    for (const name of reached) {
      const entry = health.get(name);
      if (entry === undefined) {
        continue;
      }
      entry.reached += 1;
      if (rescued.has(name)) {
        entry.rescued += 1;
      }
    }
    if (run.status !== "errored") {
      continue;
    }
    const at = failedStep(run);
    const entry = health.get(at) ?? {
      name: OUTSIDE_STEPS,
      step: null,
      reached: 0,
      failed: 0,
      rescued: 0,
      latestError: null,
    };
    entry.failed += 1;
    entry.latestError ??= run.error;
    health.set(at, entry);
  }
  return [...health.values()];
}

const STEP_COLUMNS: readonly PanelTableColumn[] = [
  { label: "Reached", align: "end" },
  { label: "Failed", align: "end" },
  { label: "Rescued", align: "end" },
  { label: "Latest error", align: "start" },
];

function StepTable({
  runs,
  paths,
}: {
  runs: readonly WorkflowHealthRun[];
  paths: WorkflowHealthPaths;
}) {
  return (
    <PanelTable title="Steps" columns={STEP_COLUMNS} empty={null} footer={null}>
      {stepHealth(runs).map((step) => (
        <PanelTableRow
          key={step.name}
          columns={STEP_COLUMNS}
          title={
            <span
              className={cn(
                "block truncate",
                step.step === null ? "text-[var(--bo-muted)] italic" : "text-[var(--bo-fg)]",
              )}
              title={step.name}
            >
              {step.name}
            </span>
          }
          cells={[
            <span key="reached" className="text-[var(--bo-muted)] tabular-nums">
              {step.step === null ? "—" : step.reached}
            </span>,
            step.failed === 0 ? (
              <span key="failed" className="text-[var(--bo-muted-2)] tabular-nums">
                0
              </span>
            ) : (
              <Link
                preventScrollReset
                key="failed"
                to={paths.filter({ kind: "step", step: step.step })}
                title={`Show the runs that failed at ${step.name}`}
                className="inline-flex cursor-pointer items-baseline gap-1.5 font-semibold text-[var(--bo-failed)] tabular-nums hover:underline"
              >
                {step.failed}
                {step.step === null ? null : (
                  <span className="text-xs font-normal text-[var(--bo-muted-2)]">
                    {percent(step.failed, step.reached)}
                  </span>
                )}
              </Link>
            ),
            <span
              key="rescued"
              className={cn(
                "tabular-nums",
                step.rescued === 0 ? "text-[var(--bo-muted-2)]" : "text-[var(--bo-waiting)]",
              )}
            >
              {step.rescued}
            </span>,
            <span
              key="error"
              className="block max-w-[28rem] truncate font-mono text-xs text-[var(--bo-muted)]"
              title={step.latestError ?? undefined}
            >
              {step.latestError ?? ""}
            </span>,
          ]}
        />
      ))}
    </PanelTable>
  );
}

const RUN_STATUS: Record<
  WorkflowHealthRun["status"],
  { label: string; tone: BackofficeStatusTone }
> = {
  active: { label: "Running", tone: "live" },
  waiting: { label: "Waiting", tone: "waiting" },
  paused: { label: "Paused", tone: "muted" },
  complete: { label: "Completed", tone: "muted" },
  terminated: { label: "Terminated", tone: "muted" },
  errored: { label: "Failed", tone: "failed" },
};

/** A run's status as the view words it, for lists of workflows beside it. */
export function WorkflowRunStatusLight({ status }: { status: WorkflowHealthRun["status"] }) {
  const { label, tone } = RUN_STATUS[status];
  return <BackofficeStatusLight tone={tone}>{label}</BackofficeStatusLight>;
}

/** What a run's row says beside its status: why it failed, what a retry rescued, where it is. */
function runDetail(run: WorkflowHealthRun): { text: string; tone: "failed" | "waiting" | null } {
  switch (run.status) {
    case "errored":
      return { text: `${failedStep(run) ?? OUTSIDE_STEPS}: ${run.error}`, tone: "failed" };
    case "complete": {
      const rescued = rescuedSteps(run);
      return rescued.length === 0
        ? { text: "", tone: null }
        : { text: `Retried ${rescued.join(", ")}`, tone: "waiting" };
    }
    case "active":
    case "waiting":
    case "paused":
      return { text: run.steps.at(-1)?.name ?? "Starting", tone: null };
    case "terminated":
      return { text: "", tone: null };
  }
}

const RUN_COLUMNS: readonly PanelTableColumn[] = [
  { label: "Outcome", align: "start" },
  { label: "Detail", align: "start" },
  { label: "Trigger", align: "start" },
  { label: "Duration", align: "end" },
];

function RunTable({
  runs,
  hiddenCount,
  onShowAll,
  openedId,
  paths,
  now,
}: {
  runs: readonly WorkflowHealthRun[];
  hiddenCount: number;
  onShowAll: () => void;
  openedId: string | null;
  paths: WorkflowHealthPaths;
  now: number;
}) {
  return (
    <PanelTable
      title="Started"
      columns={RUN_COLUMNS}
      empty="No runs match."
      footer={
        hiddenCount === 0 ? null : (
          <div className="flex justify-end border-t border-[color:var(--bo-border)] py-2 text-xs">
            <button
              type="button"
              onClick={onShowAll}
              className="cursor-pointer font-semibold text-[var(--bo-accent-fg)] hover:underline"
            >
              Show {hiddenCount} more
            </button>
          </div>
        )
      }
    >
      {runs.map((run) => {
        const detail = runDetail(run);
        const duration = runDuration(run);
        return (
          <PanelTableRow
            key={run.id}
            columns={RUN_COLUMNS}
            title={
              <Link
                preventScrollReset
                to={runPath(run, paths)}
                aria-current={run.id === openedId ? "true" : undefined}
                title={`${formatRelativeTime(new Date(run.startedAt), now)} · ${run.id}`}
                className="flex items-center gap-1.5 truncate font-semibold text-[var(--bo-fg)] tabular-nums hover:underline aria-[current]:text-[var(--bo-accent-fg)]"
              >
                {run.id === openedId ? (
                  <Icon name="chevron-right" className="-ml-1 size-3.5 shrink-0" />
                ) : null}
                {formatStart(run.startedAt, now)}
              </Link>
            }
            cells={[
              <WorkflowRunStatusLight key="status" status={run.status} />,
              <span
                key="detail"
                title={detail.text}
                className={cn(
                  "block max-w-[32rem] truncate text-xs",
                  detail.tone === "failed"
                    ? "font-mono text-[var(--bo-failed)]"
                    : detail.tone === "waiting"
                      ? "text-[var(--bo-waiting)]"
                      : "text-[var(--bo-muted)]",
                )}
              >
                {detail.text}
              </span>,
              <span key="trigger" className="text-xs text-[var(--bo-muted)]">
                {run.trigger}
              </span>,
              <span key="duration" className="text-xs text-[var(--bo-muted)] tabular-nums">
                {duration === null ? "—" : formatWorkflowDuration(duration, "fine")}
              </span>,
            ]}
          />
        );
      })}
    </PanelTable>
  );
}

/** What the opened run is the next or previous of: the filter's runs when it is one of them. */
function sequenceLabel(filter: WorkflowHealthFilter, inFilter: boolean): string {
  if (!inFilter || filter.kind === "all") {
    return "runs";
  }
  return filter.kind === "failed" ? "failed runs" : `failed at ${filter.step ?? OUTSIDE_STEPS}`;
}

const pagerLinkClassName =
  "inline-flex size-7 items-center justify-center rounded-[4px] text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none";

/**
 * The opened run under a bar that leads back to the lists, and to the newer and older runs among
 * the ones the list shows, so failures can be read one after another.
 */
function OpenedRun({
  opened,
  runs,
  filtered,
  filter,
  paths,
  now,
}: {
  opened: { id: string; view: ReactNode };
  runs: readonly WorkflowHealthRun[];
  filtered: readonly WorkflowHealthRun[];
  filter: WorkflowHealthFilter;
  paths: WorkflowHealthPaths;
  now: number;
}) {
  const inFilter = filtered.some((run) => run.id === opened.id);
  const sequence = inFilter ? filtered : runs;
  const index = sequence.findIndex((run) => run.id === opened.id);
  const run = sequence[index];
  const newer = sequence[index - 1];
  const older = sequence[index + 1];

  return (
    <section aria-label="Opened run" className="min-w-0">
      <header className="flex h-9 items-center gap-2 border-b border-[color:var(--bo-border)]">
        <Link
          preventScrollReset
          to={paths.close}
          aria-label="Close the run"
          title="Close the run"
          className={cn(pagerLinkClassName, "-ml-1.5")}
        >
          <Icon name="arrow-left" className="size-4" />
        </Link>
        <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--bo-fg)]">
          {run === undefined ? "Run" : `Run · ${formatStart(run.startedAt, now)}`}
        </h2>
        {run === undefined ? null : <WorkflowRunStatusLight status={run.status} />}
        {run === undefined ? null : (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-[var(--bo-muted-2)]">
            <span className="mr-1 tabular-nums">
              {index + 1} of {sequence.length} {sequenceLabel(filter, inFilter)}
            </span>
            {newer === undefined ? (
              <span className={cn(pagerLinkClassName, "opacity-40")} aria-hidden="true">
                <Icon name="chevron-up" className="size-4" />
              </span>
            ) : (
              <Link
                preventScrollReset
                to={runPath(newer, paths)}
                aria-label="Newer run"
                title="Newer run"
                className={pagerLinkClassName}
              >
                <Icon name="chevron-up" className="size-4" />
              </Link>
            )}
            {older === undefined ? (
              <span className={cn(pagerLinkClassName, "opacity-40")} aria-hidden="true">
                <Icon name="chevron-down" className="size-4" />
              </span>
            ) : (
              <Link
                preventScrollReset
                to={runPath(older, paths)}
                aria-label="Older run"
                title="Older run"
                className={pagerLinkClassName}
              >
                <Icon name="chevron-down" className="size-4" />
              </Link>
            )}
          </span>
        )}
      </header>
      <div className="pt-3">{opened.view}</div>
    </section>
  );
}
