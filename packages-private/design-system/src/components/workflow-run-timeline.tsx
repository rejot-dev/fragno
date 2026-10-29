import { type CSSProperties, type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { cn } from "../cn";
import { Icon } from "./icon";
import { TimelineReplayControls, useTimelineReplay } from "./timeline-replay";
import {
  formatWorkflowDuration,
  layoutWorkflowRun,
  newestWorkflowMoment,
  reachedWorkflowEndIds,
  workflowStepIterationsAt,
  workflowStepMarkAt,
  positionOnScale,
  workflowStepStatusAt,
  workflowTimeScale,
  type WorkflowRunEnd,
  type WorkflowRunEvent,
  type WorkflowRunNode,
  type WorkflowRunRail,
  type WorkflowRunRow,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowRunStepStatus,
  type WorkflowTimeScale,
} from "./workflow-run-timeline-model";

const ROW_HEIGHT = 32;
const LANE_GAP = 14;
const RAIL_INSET = 12;
const LIVE_TICK_MS = 1_000;
// Leaves room past the end of the scale so the newest bar never touches the Span column.
const AXIS_HEADROOM = 1.06;

function scaleLeft(scale: WorkflowTimeScale, at: number): string {
  return `${(positionOnScale(scale, at) / AXIS_HEADROOM) * 100}%`;
}

// A run that exists but has not begun executing shows as queued.
type RunDisplayStatus = WorkflowRunStatus | "queued";

const RUN_STATUS_LABEL: Record<RunDisplayStatus, string> = {
  queued: "Queued",
  active: "Running",
  waiting: "Waiting",
  paused: "Paused",
  complete: "Complete",
  errored: "Failed",
  terminated: "Terminated",
};

const STEP_STATUS_LABEL: Record<WorkflowRunStepStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Ok",
  failed: "Failed",
  skipped: "Skipped",
};

const STEP_STATUS_COLOR: Record<WorkflowRunStepStatus, string> = {
  pending: "var(--bo-muted-2)",
  running: "var(--bo-blue-2)",
  waiting: "var(--bo-waiting)",
  completed: "var(--bo-live)",
  failed: "var(--bo-failed)",
  skipped: "var(--bo-muted-2)",
};

/**
 * How the timeline sits on its page. On its own, it draws a header, its own time axis, and replay
 * controls. Embedded in a view that already draws the run on a time axis, such as a causal flame
 * graph, it is a list of steps that follows that view's replay cursor.
 */
export type WorkflowRunTimelinePresentation =
  | {
      kind: "standalone";
      /** Secondary run facts shown beside the status, such as the run id or parser notes. */
      meta: ReactNode;
      actions: ReactNode;
      /** A padded card, or flush against the edges of a surface that already frames it. */
      surface: "card" | "flush";
    }
  | {
      kind: "embedded";
      /** `null` follows the run live. */
      cursor: number | null;
      onHoverStep: (stepId: string | null) => void;
    };

export function WorkflowRunTimeline({
  title,
  status,
  trigger,
  createdAt,
  startedAt,
  endedAt,
  nodes,
  events,
  selectedStepId,
  onSelectStep,
  presentation,
}: {
  title: string;
  status: WorkflowRunStatus;
  /** What started the run, such as the automation event that triggered it. */
  trigger: string;
  /** When the run was enqueued; the timeline starts here so queueing time is visible. */
  createdAt: number;
  /** `null` until the run begins executing. */
  startedAt: number | null;
  /** `null` while the run can still make progress. */
  endedAt: number | null;
  nodes: readonly WorkflowRunNode[];
  /** Oldest first. */
  events: readonly WorkflowRunEvent[];
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
  presentation: WorkflowRunTimelinePresentation;
}) {
  const [expandedStepIds, setExpandedStepIds] = useState<ReadonlySet<string>>(new Set());
  const layout = useMemo(
    () => layoutWorkflowRun(nodes, expandedStepIds, trigger),
    [nodes, expandedStepIds, trigger],
  );
  const now = useNow({ live: endedAt === null, nodes, events, createdAt });
  const end = endedAt ?? now;
  const scale = useMemo(
    () => workflowTimeScale(createdAt, end, startedAt, nodes, events),
    [createdAt, end, startedAt, nodes, events],
  );
  const [ownCursor, setOwnCursor] = useState<number | null>(null);
  const replay = useTimelineReplay({ scale, cursor: ownCursor, onCursorChange: setOwnCursor });
  const cursor = presentation.kind === "embedded" ? presentation.cursor : ownCursor;
  const timed = presentation.kind === "standalone";
  const horizon = cursor ?? end;
  const railWidth = RAIL_INSET * 2 + (layout.laneCount - 1) * LANE_GAP;
  // Events are oldest first.
  const latestEvent = events.filter((event) => event.at <= horizon).at(-1) ?? null;
  const queued = startedAt === null || horizon < startedAt;
  const runStatus: RunDisplayStatus = queued ? "queued" : cursor === null ? status : "active";
  // Replay never shows exits as reached: they are only known once the run has finished.
  const reachedEndIds = useMemo(
    () => (cursor === null ? reachedWorkflowEndIds(layout, status) : new Set<string>()),
    [layout, status, cursor],
  );

  function toggleExpanded(stepId: string) {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (!next.delete(stepId)) {
        next.add(stepId);
      }
      return next;
    });
  }

  return (
    <section
      aria-label={`Workflow run ${title}`}
      className={
        presentation.kind === "standalone" && presentation.surface === "card"
          ? "overflow-hidden rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-fg)] shadow-[var(--bo-panel-shadow)]"
          : "overflow-hidden text-[var(--bo-fg)]"
      }
    >
      {presentation.kind === "standalone" ? (
        <header
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 pt-3 pb-1 text-xs",
            presentation.surface === "card" && "px-4",
          )}
        >
          <h3 className="truncate text-base font-semibold tracking-tight">{title}</h3>
          <RunStatusLabel status={runStatus} />
          <div className="flex min-w-0 items-center gap-3 text-[var(--bo-muted)]">
            {presentation.meta}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <TimelineReplayControls replay={replay} scale={scale} horizon={horizon} subject="run" />
            {presentation.actions}
          </div>
        </header>
      ) : null}

      <div
        role="table"
        aria-label="Workflow steps"
        className={cn(
          "overflow-x-auto pb-2",
          presentation.kind === "standalone" && presentation.surface === "card" && "px-2",
        )}
        style={
          {
            "--wf-rail": `${railWidth}px`,
            "--wf-columns": timed ? TIMED_COLUMNS : UNTIMED_COLUMNS,
          } as CSSProperties
        }
      >
        <div className={timed ? "min-w-[44rem]" : "min-w-[28rem]"}>
          <TimelineHeader scale={scale} timed={timed} />
          <div
            role="rowgroup"
            className="relative"
            onMouseLeave={
              presentation.kind === "embedded"
                ? () => {
                    presentation.onHoverStep(null);
                  }
                : undefined
            }
          >
            <RailGraph
              rows={layout.rows}
              rails={layout.rails}
              width={railWidth}
              cursor={cursor}
              queued={queued}
              reachedEndIds={reachedEndIds}
              selectedStepId={selectedStepId}
            />
            {layout.rows.map((row) =>
              row.kind === "start" ? (
                <StartRow
                  key={row.id}
                  row={row}
                  createdAt={createdAt}
                  startedAt={startedAt}
                  scale={scale}
                  horizon={horizon}
                  timed={timed}
                />
              ) : row.kind === "end" ? (
                <EndRow
                  key={row.id}
                  row={row}
                  reached={reachedEndIds.has(row.id)}
                  finished={cursor === null && endedAt !== null}
                  timed={timed}
                />
              ) : row.kind === "loop" ? (
                <LoopRow
                  key={row.id}
                  row={row}
                  cursor={cursor}
                  scale={scale}
                  horizon={horizon}
                  timed={timed}
                />
              ) : (
                <StepRow
                  key={row.id}
                  row={row}
                  cursor={cursor}
                  expanded={expandedStepIds.has(row.step.id)}
                  selected={row.step.id === selectedStepId}
                  scale={scale}
                  horizon={horizon}
                  timed={timed}
                  onSelect={() => {
                    onSelectStep(row.step.id);
                  }}
                  onHover={() => {
                    if (presentation.kind === "embedded") {
                      presentation.onHoverStep(row.step.id);
                    }
                  }}
                  onToggleExpanded={() => {
                    toggleExpanded(row.step.id);
                  }}
                />
              ),
            )}
          </div>
        </div>
      </div>

      <LatestEvent event={latestEvent} createdAt={createdAt} />
    </section>
  );
}

function RunStatusLabel({ status }: { status: RunDisplayStatus }) {
  const color =
    status === "complete"
      ? STEP_STATUS_COLOR.completed
      : status === "errored"
        ? STEP_STATUS_COLOR.failed
        : status === "waiting" || status === "paused"
          ? STEP_STATUS_COLOR.waiting
          : status === "terminated" || status === "queued"
            ? STEP_STATUS_COLOR.skipped
            : STEP_STATUS_COLOR.running;

  return (
    <span className="inline-flex items-center gap-1.5 font-medium" style={{ color }}>
      {status === "active" ? (
        <Spinner />
      ) : (
        <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      )}
      <span className="text-[var(--bo-fg)]">{RUN_STATUS_LABEL[status]}</span>
    </span>
  );
}

// Embedded timelines leave the time axis to the view around them and only keep each step's span.
const TIMED_COLUMNS = "var(--wf-rail) minmax(10rem,1.5fr) 6rem 5rem minmax(10rem,1.6fr) 4rem";
const UNTIMED_COLUMNS = "var(--wf-rail) minmax(10rem,1fr) 6rem 5rem 4rem";
const ROW_GRID = "grid grid-cols-[var(--wf-columns)] items-center gap-x-3";

function TimelineHeader({ scale, timed }: { scale: WorkflowTimeScale; timed: boolean }) {
  return (
    <div
      role="row"
      className={cn(
        ROW_GRID,
        "h-7 border-b border-[color:var(--bo-border)] pr-2 text-xs text-[var(--bo-muted-2)]",
      )}
    >
      <span role="columnheader" aria-label="Path" />
      <span role="columnheader">Step</span>
      <span role="columnheader">State</span>
      <span role="columnheader">Attempt</span>
      {timed ? (
        <span role="columnheader" className="relative h-full">
          <AxisLabels scale={scale} />
        </span>
      ) : null}
      <span role="columnheader" className="text-right">
        Span
      </span>
    </div>
  );
}

function AxisLabels({ scale }: { scale: WorkflowTimeScale }) {
  return (
    <>
      {scale.ticks.map((tick) => (
        <span
          key={tick.offset}
          className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap tabular-nums"
          style={{ left: `${(tick.position / AXIS_HEADROOM) * 100}%` }}
        >
          {formatWorkflowDuration(tick.offset, "coarse")}
        </span>
      ))}
      {scale.segments.map((segment) =>
        segment.idle ? (
          <span
            key={segment.from}
            title={`Idle for ${formatWorkflowDuration(segment.to - segment.from, "coarse")}`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-[var(--bo-panel)] px-1 text-[10px] whitespace-nowrap text-[var(--bo-muted-2)] tabular-nums"
            style={{
              left: `${((segment.position + segment.width / 2) / AXIS_HEADROOM) * 100}%`,
            }}
          >
            {formatWorkflowDuration(segment.to - segment.from, "coarse")}
          </span>
        ) : null,
      )}
    </>
  );
}

type StepRowModel = Extract<WorkflowRunRow, { kind: "step" }>;
type LoopRowModel = Extract<WorkflowRunRow, { kind: "loop" }>;
type EndRowModel = Extract<WorkflowRunRow, { kind: "end" }>;

type StartRowModel = Extract<WorkflowRunRow, { kind: "start" }>;

function StartRow({
  row,
  createdAt,
  startedAt,
  scale,
  horizon,
  timed,
}: {
  row: StartRowModel;
  createdAt: number;
  startedAt: number | null;
  scale: WorkflowTimeScale;
  horizon: number;
  timed: boolean;
}) {
  const queuedUntil = Math.min(startedAt ?? horizon, horizon);
  const queued = startedAt === null || horizon < startedAt;

  return (
    <div role="row" className={cn(ROW_GRID, "pr-2 text-sm")} style={{ height: ROW_HEIGHT }}>
      <span role="cell" />
      <span role="cell" className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-xs text-[var(--bo-muted-2)]">start</span>
        <span className="truncate text-[var(--bo-muted)]" title={row.trigger}>
          {row.trigger}
        </span>
      </span>
      <span role="cell" className="text-xs whitespace-nowrap text-[var(--bo-muted)]">
        {queued ? "Queued" : "Started"}
      </span>
      <span role="cell" />
      {timed ? (
        <span role="cell" className="relative h-full">
          <TimelineTrack
            marks={[
              {
                mark: { kind: "bar", startedAt: createdAt, endedAt: queuedUntil },
                color: "var(--bo-muted-2)",
              },
            ]}
            scale={scale}
            horizon={horizon}
          />
        </span>
      ) : null}
      <span role="cell" className="text-right text-xs text-[var(--bo-muted)] tabular-nums">
        {formatWorkflowDuration(queuedUntil - createdAt, "coarse")}
      </span>
    </div>
  );
}

const END_LABEL: Record<WorkflowRunEnd["reason"], { pending: string; reached: string }> = {
  return: { pending: "Returns", reached: "Returned" },
  error: { pending: "Throws", reached: "Threw" },
  caught: { pending: "Throws to catch", reached: "Threw to catch" },
};

/** `finished` dims exits a finished run provably did not stop at. */
function EndRow({
  row,
  reached,
  finished,
  timed,
}: {
  row: EndRowModel;
  reached: boolean;
  finished: boolean;
  timed: boolean;
}) {
  const labels = END_LABEL[row.end.reason];
  const tone = reached
    ? "text-[var(--bo-fg)]"
    : finished
      ? "text-[var(--bo-muted-2)]"
      : "text-[var(--bo-muted)]";

  return (
    <div role="row" className={cn(ROW_GRID, "pr-2 text-sm", tone)} style={{ height: ROW_HEIGHT }}>
      <span role="cell" />
      <span role="cell" className="flex min-w-0 items-center gap-1.5">
        <RowLabel label={row.label} />
        <span className={cn("truncate", reached && "font-medium")} title={row.end.label}>
          {row.end.label}
        </span>
      </span>
      <span role="cell" className="text-xs whitespace-nowrap">
        {reached ? labels.reached : labels.pending}
      </span>
      <span role="cell" />
      {timed ? <span role="cell" /> : null}
      <span role="cell" />
    </div>
  );
}

/**
 * A loop's header, where each iteration starts over. It counts the iterations its busiest step has
 * started and spans the time from the first step inside it to the newest. A loop whose body is only
 * inner loops cannot count its own iterations, so it says whether it is running or ran instead.
 */
function LoopRow({
  row,
  cursor,
  scale,
  horizon,
  timed,
}: {
  row: LoopRowModel;
  cursor: number | null;
  scale: WorkflowTimeScale;
  horizon: number;
  timed: boolean;
}) {
  const iterations = Math.max(
    0,
    ...row.loop.steps.map((step) => workflowStepIterationsAt(step, cursor)),
  );
  const statuses = row.loop.allSteps.map((step) => workflowStepStatusAt(step, cursor));
  const activity =
    iterations > 0
      ? `${iterations} ${iterations === 1 ? "iteration" : "iterations"}`
      : statuses.some((status) => status === "running" || status === "waiting")
        ? "Running"
        : statuses.every((status) => status === "pending" || status === "skipped")
          ? "Not run"
          : "Ran";
  const bars = row.loop.allSteps.flatMap((step) => {
    const mark = workflowStepMarkAt(step, horizon);
    return mark.kind === "bar" ? [mark] : [];
  });
  const mark: ReturnType<typeof workflowStepMarkAt> =
    bars.length === 0
      ? { kind: "none" }
      : {
          kind: "bar",
          startedAt: Math.min(...bars.map((bar) => bar.startedAt)),
          endedAt: Math.max(...bars.map((bar) => bar.endedAt)),
        };

  return (
    <div
      role="row"
      className={cn(ROW_GRID, "pr-2 text-sm text-[var(--bo-muted)]")}
      style={{ height: ROW_HEIGHT }}
    >
      <span role="cell" />
      <span role="cell" className="flex min-w-0 items-center gap-1.5">
        <RowLabel label={row.label} />
        <Icon name="repeat" className="size-3 shrink-0 text-[var(--bo-muted-2)]" />
        <span className="truncate font-mono text-xs" title={row.loop.label}>
          {row.loop.label}
        </span>
      </span>
      <span role="cell" className="text-xs whitespace-nowrap tabular-nums">
        {activity}
      </span>
      <span role="cell" />
      {timed ? (
        <span role="cell" className="relative h-full">
          <TimelineTrack
            marks={[{ mark, color: "var(--bo-muted-2)" }]}
            scale={scale}
            horizon={horizon}
          />
        </span>
      ) : null}
      <span role="cell" className="text-right text-xs tabular-nums">
        {mark.kind === "bar"
          ? formatWorkflowDuration(mark.endedAt - mark.startedAt, "coarse")
          : "—"}
      </span>
    </div>
  );
}

/** Branch, loop, and handler labels lead the row but give way to the step name when space is short. */
function RowLabel({ label }: { label: string | null }) {
  if (label === null) {
    return null;
  }
  return (
    <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--bo-muted-2)]" title={label}>
      {label}
    </span>
  );
}

function StepRow({
  row,
  cursor,
  expanded,
  selected,
  scale,
  horizon,
  timed,
  onSelect,
  onHover,
  onToggleExpanded,
}: {
  row: StepRowModel;
  cursor: number | null;
  expanded: boolean;
  selected: boolean;
  scale: WorkflowTimeScale;
  horizon: number;
  timed: boolean;
  onSelect: () => void;
  onHover: () => void;
  onToggleExpanded: () => void;
}) {
  const step = row.step;
  const status = workflowStepStatusAt(step, cursor);
  const iterations = workflowStepIterationsAt(step, cursor);
  const mark = workflowStepMarkAt(step, horizon);
  // A repeated step draws each iteration in its own state, so the gaps and failures between them
  // stay visible.
  const marks =
    step.iterations.length === 0
      ? [{ mark, color: STEP_STATUS_COLOR[status] }]
      : step.iterations.map((iteration) => ({
          mark: workflowStepMarkAt(iteration, horizon),
          color: STEP_STATUS_COLOR[workflowStepStatusAt(iteration, cursor)],
        }));
  const expandable = step.iterations.length > 0 || step.children.length > 0;
  // A repeated step speaks for its newest iteration so far: its name, attempts, and detail.
  const current = step.iterations[iterations - 1] ?? step;
  const currentName = current.label === step.label ? null : current.label;
  // Details and attempt counts describe the final outcome, so replay holds them back until then.
  const showsOutcome = workflowStepStatusAt(current, cursor) === current.status;
  const detail = showsOutcome ? current.detail : null;

  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        ROW_GRID,
        "cursor-pointer rounded-[4px] pr-2 text-sm transition-colors duration-150",
        selected
          ? "bg-[var(--bo-waiting-bg)]"
          : "hover:bg-[color-mix(in_srgb,var(--bo-panel-2)_70%,transparent)]",
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <span role="cell" />
      <span
        role="cell"
        className="flex min-w-0 items-center gap-1.5"
        style={{ paddingLeft: row.depth * 16 }}
      >
        <RowLabel label={row.label} />
        {!expandable ? null : (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${step.label}`}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded();
            }}
            className="-ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-[3px] text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
          >
            <Icon name={expanded ? "minus" : "plus"} className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className={cn(
            "max-w-[75%] shrink-0 truncate text-left focus-visible:underline focus-visible:outline-none",
            row.depth > 0 ? "text-[var(--bo-muted)]" : "font-medium",
          )}
          title={step.label}
        >
          {step.label}
        </button>
        {iterations === 0 ? null : (
          <span
            className="shrink-0 rounded-[3px] bg-[var(--bo-panel-2)] px-1 text-[11px] text-[var(--bo-muted)] tabular-nums"
            title={`Ran ${iterations} ${iterations === 1 ? "time" : "times"}`}
          >
            ×{iterations}
          </span>
        )}
        {currentName === null && detail === null ? null : (
          <span
            className="min-w-0 truncate text-xs text-[var(--bo-muted-2)]"
            title={[currentName, detail].filter((part) => part !== null).join(" · ")}
          >
            {[currentName, detail].filter((part) => part !== null).join(" · ")}
          </span>
        )}
      </span>
      <span role="cell" className="flex items-center">
        <StepStatusLabel status={status} />
      </span>
      <span role="cell" className="flex items-center">
        {showsOutcome ? (
          <AttemptMeter attempts={current.attempts} status={status} />
        ) : (
          <span className="text-xs text-[var(--bo-muted-2)]">—</span>
        )}
      </span>
      {timed ? (
        <span role="cell" className="relative h-full">
          <TimelineTrack marks={marks} scale={scale} horizon={horizon} />
        </span>
      ) : null}
      <span role="cell" className="text-right text-xs text-[var(--bo-muted)] tabular-nums">
        {mark.kind === "bar"
          ? formatWorkflowDuration(mark.endedAt - mark.startedAt, "coarse")
          : "—"}
      </span>
    </div>
  );
}

function StepStatusLabel({ status }: { status: WorkflowRunStepStatus }) {
  const color = STEP_STATUS_COLOR[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span className="flex size-2.5 items-center justify-center" style={{ color }}>
        {status === "running" ? (
          <Spinner />
        ) : status === "pending" ? (
          <span className="size-2 rounded-full border border-current" aria-hidden="true" />
        ) : status === "skipped" ? (
          <span className="h-0.5 w-2 rounded-full bg-current" aria-hidden="true" />
        ) : (
          <span className="size-2 rounded-full bg-current" aria-hidden="true" />
        )}
      </span>
      {STEP_STATUS_LABEL[status]}
    </span>
  );
}

function AttemptMeter({
  attempts,
  status,
}: {
  attempts: WorkflowRunStep["attempts"];
  status: WorkflowRunStepStatus;
}) {
  // A step without retries has nothing to say here; a dash keeps the column scannable.
  if (attempts.max <= 1) {
    return <span className="text-xs text-[var(--bo-muted-2)]">—</span>;
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="text-xs text-[var(--bo-muted)] tabular-nums">
        {attempts.count}/{attempts.max}
      </span>
      <span className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--bo-border)]">
        <span
          className="block h-full rounded-full transition-[width] duration-300 ease-out"
          style={{
            width: `${Math.min(attempts.count / attempts.max, 1) * 100}%`,
            background: STEP_STATUS_COLOR[status],
          }}
        />
      </span>
    </span>
  );
}

function TimelineTrack({
  marks,
  scale,
  horizon,
}: {
  marks: readonly { mark: ReturnType<typeof workflowStepMarkAt>; color: string }[];
  scale: WorkflowTimeScale;
  horizon: number;
}) {
  return (
    <>
      {scale.ticks.map((tick) => (
        <span
          key={tick.offset}
          aria-hidden="true"
          className="absolute inset-y-2 w-px bg-[var(--bo-border)]"
          style={{ left: `${(tick.position / AXIS_HEADROOM) * 100}%` }}
        />
      ))}
      {scale.segments.map((segment) =>
        segment.idle ? (
          <span
            key={segment.from}
            aria-hidden="true"
            className="absolute inset-y-1.5 bg-[repeating-linear-gradient(135deg,var(--bo-border)_0_1px,transparent_1px_5px)]"
            style={{
              left: `${(segment.position / AXIS_HEADROOM) * 100}%`,
              width: `${(segment.width / AXIS_HEADROOM) * 100}%`,
            }}
          />
        ) : null,
      )}
      <span
        aria-hidden="true"
        className="absolute inset-y-1 w-px bg-[var(--bo-muted-2)]"
        style={{ left: scaleLeft(scale, horizon) }}
      />
      {marks.map(({ mark, color }, index) =>
        mark.kind === "bar" ? (
          <span
            key={index}
            className="absolute top-1/2 h-1.5 min-w-1.5 -translate-y-1/2 rounded-full opacity-85"
            style={{
              left: scaleLeft(scale, mark.startedAt),
              width: `${((positionOnScale(scale, mark.endedAt) - positionOnScale(scale, mark.startedAt)) / AXIS_HEADROOM) * 100}%`,
              background: color,
            }}
          />
        ) : mark.kind === "point" ? (
          // Only the commit time is durable for steps that finish within one tick.
          <span
            key={index}
            className="absolute top-1/2 flex -translate-x-[3px] -translate-y-1/2 items-center gap-1 text-[10px] text-[var(--bo-muted-2)]"
            style={{ left: scaleLeft(scale, mark.at) }}
            title="Start time not recorded"
          >
            <span className="size-1.5 rounded-full" style={{ background: color }} />?
          </span>
        ) : null,
      )}
    </>
  );
}

function RailGraph({
  rows,
  rails,
  width,
  cursor,
  queued,
  reachedEndIds,
  selectedStepId,
}: {
  rows: readonly WorkflowRunRow[];
  rails: readonly WorkflowRunRail[];
  width: number;
  cursor: number | null;
  queued: boolean;
  reachedEndIds: ReadonlySet<string>;
  selectedStepId: string | null;
}) {
  const x = (lane: number) => width - RAIL_INSET - lane * LANE_GAP;
  const y = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  // Nested child rows ride on their parent's rail without a node of their own.
  const nodes = rows.flatMap((row, index) => (row.depth === 0 ? [{ row, index }] : []));
  const markerId = useId();
  const tones = {
    muted: { color: "var(--bo-muted-2)", opacity: 0.6, width: 1.25 },
    highlighted: { color: "var(--bo-blue-2)", opacity: 1, width: 1.75 },
    fault: { color: "var(--bo-failed)", opacity: 0.55, width: 1.25 },
  };

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={rows.length * ROW_HEIGHT}
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
    >
      <defs>
        {Object.entries(tones).map(([tone, style]) => (
          <marker
            key={tone}
            id={`${markerId}-${tone}`}
            viewBox="0 0 6 6"
            refX="5"
            refY="3"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0 0 L6 3 L0 6 z" fill={style.color} fillOpacity={style.opacity} />
          </marker>
        ))}
      </defs>
      {rails.map((rail) => {
        const tone =
          rail.kind === "throw"
            ? "fault"
            : rail.fromRowId === selectedStepId
              ? "highlighted"
              : "muted";
        const style = tones[tone];
        return (
          <polyline
            key={rail.id}
            points={railPoints(rail, x, y)}
            fill="none"
            stroke={style.color}
            strokeOpacity={style.opacity}
            strokeWidth={style.width}
            strokeLinejoin="round"
            strokeDasharray={
              rail.kind === "repeat" ? "3 3" : rail.kind === "throw" ? "2 3" : undefined
            }
            markerEnd={`url(#${markerId}-${tone})`}
          />
        );
      })}
      {nodes.map(({ row, index }) =>
        row.kind === "start" ? (
          <StartNode key={row.id} cx={x(row.lane)} cy={y(index)} queued={queued} />
        ) : row.kind === "end" ? (
          <EndNode
            key={row.id}
            cx={x(row.lane)}
            cy={y(index)}
            reason={row.end.reason}
            reached={reachedEndIds.has(row.id)}
          />
        ) : row.kind === "loop" ? (
          <LoopNode key={row.id} cx={x(row.lane)} cy={y(index)} />
        ) : (
          <RailNode
            key={row.id}
            cx={x(row.lane)}
            cy={y(index)}
            status={workflowStepStatusAt(row.step, cursor)}
            selected={row.id === selectedStepId}
          />
        ),
      )}
    </svg>
  );
}

// Node radius plus a gap, so arrowheads stop at the circle's edge instead of under it.
const NODE_CLEARANCE = 7;

function railPoints(
  rail: WorkflowRunRail,
  x: (lane: number) => number,
  y: (row: number) => number,
): string {
  const points = rail.points.map((point) => ({ x: x(point.lane), y: y(point.row) }));
  const [first, second] = points;
  const last = points.at(-1);
  const beforeLast = points.at(-2);
  if (!first || !second || !last || !beforeLast) {
    return "";
  }
  // Throw rails leave the spine between rows, where there is no node to clear.
  const trimmed = [
    rail.kind === "throw" ? first : towards(first, second, NODE_CLEARANCE),
    ...points.slice(1, -1),
    towards(last, beforeLast, NODE_CLEARANCE),
  ];
  return trimmed.map((point) => `${point.x},${point.y}`).join(" ");
}

function towards(
  from: { x: number; y: number },
  to: { x: number; y: number },
  distance: number,
): { x: number; y: number } {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) {
    return from;
  }
  const ratio = Math.min(distance / length, 1);
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function StartNode({ cx, cy, queued }: { cx: number; cy: number; queued: boolean }) {
  return (
    <path
      d={`M${cx - 3.5} ${cy - 4.5} L${cx + 4.5} ${cy} L${cx - 3.5} ${cy + 4.5} Z`}
      fill={queued ? "var(--bo-panel)" : "var(--bo-muted-2)"}
      stroke="var(--bo-muted-2)"
      strokeWidth={1.25}
      strokeLinejoin="round"
    />
  );
}

function EndNode({
  cx,
  cy,
  reason,
  reached,
}: {
  cx: number;
  cy: number;
  reason: WorkflowRunEnd["reason"];
  reached: boolean;
}) {
  const color =
    reason === "return" ? (reached ? "var(--bo-live)" : "var(--bo-muted-2)") : "var(--bo-failed)";
  return (
    <g stroke={color} strokeWidth={1.25} fill={reached ? color : "var(--bo-panel)"}>
      <rect x={cx - 4} y={cy - 4} width={8} height={8} rx={1.5} />
      {reason === "return" ? (
        <rect
          x={cx - 1.5}
          y={cy - 1.5}
          width={3}
          height={3}
          fill={reached ? "var(--bo-panel)" : color}
          stroke="none"
        />
      ) : (
        <path
          stroke={reached ? "var(--bo-panel)" : color}
          strokeOpacity={reason === "caught" ? 0.6 : 1}
          d={`M${cx - 2} ${cy - 2} L${cx + 2} ${cy + 2} M${cx + 2} ${cy - 2} L${cx - 2} ${cy + 2}`}
        />
      )}
    </g>
  );
}

function LoopNode({ cx, cy }: { cx: number; cy: number }) {
  return (
    <rect
      x={cx - 3.5}
      y={cy - 3.5}
      width={7}
      height={7}
      transform={`rotate(45 ${cx} ${cy})`}
      fill="var(--bo-panel)"
      stroke="var(--bo-muted-2)"
      strokeWidth={1.25}
    />
  );
}

function RailNode({
  cx,
  cy,
  status,
  selected,
}: {
  cx: number;
  cy: number;
  status: WorkflowRunStepStatus;
  selected: boolean;
}) {
  const color = STEP_STATUS_COLOR[status];
  const radius = selected ? 6 : 4.5;

  if (status === "skipped") {
    return (
      <g stroke={color} strokeWidth={1.25} fill="var(--bo-panel)">
        <circle cx={cx} cy={cy} r={radius} />
        <line x1={cx - 3} y1={cy + 3} x2={cx + 3} y2={cy - 3} />
      </g>
    );
  }

  if (status === "pending") {
    return (
      <circle cx={cx} cy={cy} r={radius} fill="var(--bo-panel)" stroke={color} strokeWidth={1.25} />
    );
  }

  if (status === "running") {
    const ring = radius + 2.5;
    return (
      <g>
        <circle cx={cx} cy={cy} r={ring} fill="none" stroke={color} strokeOpacity={0.2} />
        {/* A CSS animation, unlike SMIL, honours the reduced-motion preference. */}
        <circle
          cx={cx}
          cy={cy}
          r={ring}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${ring * 2} ${ring * 8}`}
          className="animate-spin"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
        <circle cx={cx} cy={cy} r={radius - 1} fill={color} />
      </g>
    );
  }

  return (
    <g>
      {status === "waiting" ? (
        <circle cx={cx} cy={cy} r={radius + 2.5} fill="none" stroke={color} strokeWidth={1}>
          <animate
            attributeName="opacity"
            values="0.8;0.15;0.8"
            dur="1.6s"
            repeatCount="indefinite"
          />
        </circle>
      ) : null}
      <circle cx={cx} cy={cy} r={radius} fill={color} />
    </g>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
    />
  );
}

function LatestEvent({ event, createdAt }: { event: WorkflowRunEvent | null; createdAt: number }) {
  if (event === null) {
    return null;
  }

  return (
    <details className="group border-t border-[color:var(--bo-border)] px-4 py-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[var(--bo-muted-2)] marker:hidden">
        <Icon
          name="chevron-right"
          className="size-3 shrink-0 transition-transform duration-150 group-open:rotate-90"
        />
        <span>Latest event</span>
        <span className="tabular-nums">
          {formatWorkflowDuration(Math.max(event.at - createdAt, 0), "fine")}
        </span>
        <span>{event.source}</span>
        <span className="truncate font-mono text-[var(--bo-fg)] group-open:hidden">
          {event.message}
        </span>
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] leading-5 break-all whitespace-pre-wrap text-[var(--bo-fg)]">
        {event.message}
      </pre>
    </details>
  );
}

/**
 * Server and client agree on the first render by starting from the newest recorded timestamp;
 * the wall clock only takes over after mount.
 */
function useNow({
  live,
  nodes,
  events,
  createdAt,
}: {
  live: boolean;
  nodes: readonly WorkflowRunNode[];
  events: readonly WorkflowRunEvent[];
  createdAt: number;
}): number {
  const recorded = useMemo(
    () => newestWorkflowMoment(nodes, events, createdAt),
    [nodes, events, createdAt],
  );
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (!live) {
      return undefined;
    }
    const interval = setInterval(() => {
      setNow(Date.now());
    }, LIVE_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [live]);

  return live && now !== null ? Math.max(now, recorded) : recorded;
}
