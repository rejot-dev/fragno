import type { AutomationEventCausation } from "@fragno-dev/backoffice-api/v0/events";
import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { Button } from "@fragno-private/design-system/button";
import { CausalFlameGraph } from "@fragno-private/design-system/causal-flame-graph";
import {
  causalFlameNodeAt,
  causalFlamePath,
  type CausalFlameNode,
  type CausalFlameStatus,
} from "@fragno-private/design-system/causal-flame-graph-model";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { cn } from "@fragno-private/design-system/cn";
import { CopyButton } from "@fragno-private/design-system/copy-button";
import { BackofficeDownloadState } from "@fragno-private/design-system/download-state";
import { Icon } from "@fragno-private/design-system/icon";
import { PaneSpinner } from "@fragno-private/design-system/pane-message";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { formatWorkflowDuration } from "@fragno-private/design-system/workflow-run-timeline-model";
import { Fragment, Suspense, use, useMemo, useState, type ReactNode } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { useClock } from "@/components/backoffice/use-clock";
import { getAutomationReplica, useAutomationRead } from "@/fragno/automation/lofi/replica";
import { describeAutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";
import { LofiReplicaGate } from "@/fragno/lofi/replica-gate";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import { formatTimestamp } from "../automations/formatting";
import { loadPageSources } from "../pages/load.server";
import { shouldRevalidateWithinScope } from "../scope-revalidation";
import type { Route } from "./+types/events";
import { DashboardTabs } from "./dashboard-tabs";
import {
  describeRouteDispatchProgress,
  describeRouteDispatchSkipReason,
  eventTraceStepNodeId,
  projectEventTrace,
  projectEventTraceList,
  type EventTrace,
  type EventTraceDispatch,
  type EventTraceEvent,
  type EventTraceListEntry,
  type EventTraceRecord,
  type EventTraceRun,
  type EventTraceSummary,
} from "./event-traces";
import {
  dashboardEventsPath,
  dashboardOpenedTrace,
  dashboardRunPath,
  dashboardSelectedTraceNode,
  withSelectedTraceNode,
} from "./path";
import { retryEventRoute, type RouteRetryActionData } from "./route-retry.server";
import { WorkflowRunDetail } from "./workflow-run-detail";

const TRACE_LIMIT = 100;
const DOWNLOAD_TITLE = "Downloading automation activity…";
const CLOCK_TICK_MS = 60_000;
const pageClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;
const sectionHeaderClassName =
  "flex h-9 items-center gap-2 border-b border-[color:var(--bo-border)]";
const sectionTitleClassName = "text-sm font-semibold text-[var(--bo-fg)]";

/** Traces come from the scope's Automations replica; the loader only selects scope. */
export async function loader({ context }: Route.LoaderArgs) {
  return {
    selectedScope: requireScopeSelection(context),
    pageSources: loadPageSources(context),
  };
}

/** The only write here retries a route; its new state arrives through the synchronized rows. */
export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  if (formData.get("intent") !== "retry-route") {
    return { ok: false, message: "Unknown events action." } satisfies RouteRetryActionData;
  }
  return await retryEventRoute(context, {
    eventId: String(formData.get("eventId") ?? ""),
    routeId: String(formData.get("routeId") ?? ""),
  });
}

/** Opening a trace only changes the URL. */
export const shouldRevalidate = shouldRevalidateWithinScope;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Events · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeDashboardEvents({ loaderData }: Route.ComponentProps) {
  const { selectedScope, pageSources } = loaderData;
  // The replica's database opens before its download reports progress.
  const loading = <BackofficeDownloadState title={DOWNLOAD_TITLE} fraction={null} error={null} />;

  return (
    <>
      <DashboardTabs
        selectedScope={selectedScope}
        active={{ kind: "events" }}
        pageSources={pageSources}
      />
      <div className={pageClassName}>
        <h1 className="sr-only">Events in {selectedScope.label}</h1>
        <ClientOnly fallback={loading}>
          <Suspense fallback={loading}>
            <EventsClient selectedScope={selectedScope} />
          </Suspense>
        </ClientOnly>
      </div>
    </>
  );
}

function EventsClient({ selectedScope }: { selectedScope: BackofficeScopeSelection }) {
  const { automationReplicaSource } = useCurrentBackofficeContext();
  if (automationReplicaSource.status === "unavailable") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Automation events could not be synchronized."
        description={automationReplicaSource.message}
      />
    );
  }
  const source = automationReplicaSource.source;
  const replica = use(getAutomationReplica(source));
  return (
    <LofiReplicaGate replica={replica} title={DOWNLOAD_TITLE}>
      <EventTracesWorkspace
        key={describeAutomationReplicaSource(source).resourceKey}
        selectedScope={selectedScope}
        replica={replica}
      />
    </LofiReplicaGate>
  );
}

function EventTracesWorkspace({
  selectedScope,
  replica,
}: {
  selectedScope: BackofficeScopeSelection;
  replica: LofiSqliteClient;
}) {
  const [searchParams] = useSearchParams();
  const now = useClock(CLOCK_TICK_MS);
  const listRead = useAutomationRead(replica, "eventTraceSummaries", { limit: TRACE_LIMIT });
  const summaries = listRead.status === "ready" ? listRead.data : null;
  const entries = useMemo(() => (summaries ? projectEventTraceList(summaries) : []), [summaries]);
  const openedTrace = dashboardOpenedTrace(searchParams) ?? newestTraceOf(entries[0]) ?? null;
  const traceRead = useAutomationRead(openedTrace === null ? null : replica, "eventTrace", {
    rootEventId: openedTrace ?? "",
  });
  const trace = useMemo(
    () =>
      traceRead.status === "ready" && openedTrace !== null
        ? projectEventTrace({ rootEventId: openedTrace, ...traceRead.data })
        : undefined,
    [traceRead, openedTrace],
  );

  if (listRead.status === "error" || traceRead.status === "error") {
    const message =
      listRead.status === "error"
        ? listRead.message
        : traceRead.status === "error"
          ? traceRead.message
          : null;
    return (
      <BackofficeSystemState
        tone="error"
        title="Automation events could not be read."
        description={message ?? "Reload to try again."}
      />
    );
  }
  if (summaries === null) {
    return <PaneSpinner label="Reading automation events" />;
  }
  if (summaries.length === 0) {
    return (
      <BackofficeSystemState
        tone="empty"
        title="No events yet"
        description="Events from integrations, forms, and workflows appear here with everything they set in motion."
      />
    );
  }

  return (
    <div className="grid items-start gap-x-10 gap-y-8 xl:grid-cols-[21rem_minmax(0,1fr)]">
      <TraceList
        entries={entries}
        capped={summaries.length === TRACE_LIMIT}
        openedTrace={openedTrace}
        selectedScope={selectedScope}
        now={now}
      />
      {trace === undefined ? (
        <PaneSpinner label="Reading the trace" />
      ) : trace === null ? (
        <p className="py-5 text-sm text-[var(--bo-muted)]">
          There is no event {openedTrace} in this scope.
        </p>
      ) : (
        <TraceView
          key={openedTrace}
          trace={trace}
          selectedScope={selectedScope}
          replica={replica}
        />
      )}
    </div>
  );
}

function entryTraces(entry: EventTraceListEntry): readonly EventTraceSummary[] {
  return entry.kind === "trace" ? [entry.trace] : entry.traces;
}

function newestTraceOf(entry: EventTraceListEntry | undefined): string | undefined {
  return entry === undefined ? undefined : entryTraces(entry)[0]?.rootEventId;
}

// The reader's own clock, since they compare traces with when things happened around them.
const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// Repeats can be seconds apart, so the rows of an expanded group tell them apart by the second.
const preciseClockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const momentFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" });

function startOfDay(date: Date): number {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function dayLabel(date: Date, now: number): string {
  // Rounded, because a day around a daylight saving change is an hour shorter or longer.
  const daysAgo = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
  return daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : dayFormat.format(date);
}

/** Entries under the day their newest trace happened on. */
function entriesByDay(
  entries: readonly EventTraceListEntry[],
  now: number,
): { label: string; entries: EventTraceListEntry[] }[] {
  const days: { label: string; entries: EventTraceListEntry[] }[] = [];
  for (const entry of entries) {
    const newest = entryTraces(entry)[0];
    const label = newest === undefined ? "" : dayLabel(newest.occurredAt, now);
    const day = days.at(-1);
    if (day?.label === label) {
      day.entries.push(entry);
    } else {
      days.push({ label, entries: [entry] });
    }
  }
  return days;
}

type TraceTone = "failed" | "live" | "waiting" | "settled" | "unhandled";

function traceTone({ outcome }: EventTraceSummary): TraceTone {
  if (outcome.kind === "unhandled") {
    return "unhandled";
  }
  if (outcome.failedCount > 0) {
    return "failed";
  }
  if (outcome.kind === "in_progress") {
    return outcome.state === "running" ? "live" : "waiting";
  }
  return "settled";
}

const TRACE_TICK_CLASS: Record<TraceTone, string> = {
  failed: "bg-[var(--bo-failed)]",
  live: "bg-[var(--bo-live)]",
  waiting: "bg-[var(--bo-waiting)]",
  settled: "bg-[var(--bo-muted-2)]/45",
  unhandled: "bg-[var(--bo-muted-2)]/20",
};

const TRACE_TONE_LABEL: Record<TraceTone, string> = {
  failed: "failed",
  live: "running",
  waiting: "waiting",
  settled: "settled",
  unhandled: "unhandled",
};

/** Only what needs attention gets a status; settled work is the quiet default. */
function AttentionLight({
  failedCount,
  state,
}: {
  failedCount: number;
  state: "running" | "waiting" | null;
}) {
  if (failedCount > 0) {
    return <BackofficeStatusLight tone="failed">{failedCount} failed</BackofficeStatusLight>;
  }
  if (state === null) {
    return null;
  }
  return (
    <BackofficeStatusLight tone={state === "running" ? "live" : "waiting"}>
      {state === "running" ? "Running" : "Waiting"}
    </BackofficeStatusLight>
  );
}

function TraceOutcome({ summary }: { summary: EventTraceSummary }) {
  const { outcome } = summary;
  if (outcome.kind === "unhandled") {
    return null;
  }
  if (outcome.kind === "in_progress" || outcome.failedCount > 0) {
    return (
      <AttentionLight
        failedCount={outcome.failedCount}
        state={outcome.kind === "in_progress" ? outcome.state : null}
      />
    );
  }
  const duration = outcome.settledAt.getTime() - summary.occurredAt.getTime();
  return duration <= 0 ? null : (
    <span
      className="shrink-0 text-xs text-[var(--bo-muted-2)] tabular-nums"
      title="From the event to the last thing it set in motion"
    >
      {formatWorkflowDuration(duration, "fine")}
    </span>
  );
}

function RepeatsOutcome({ traces }: { traces: readonly EventTraceSummary[] }) {
  const outcomes = traces.map((trace) => trace.outcome);
  const states = outcomes.flatMap((outcome) =>
    outcome.kind === "in_progress" ? [outcome.state] : [],
  );
  return (
    <AttentionLight
      failedCount={outcomes.reduce(
        (count, outcome) => count + (outcome.kind === "unhandled" ? 0 : outcome.failedCount),
        0,
      )}
      state={states.includes("running") ? "running" : states.includes("waiting") ? "waiting" : null}
    />
  );
}

function TraceLabel({ summary }: { summary: EventTraceSummary }) {
  return (
    <span className="min-w-0 flex-1 truncate text-[13px]">
      <span className="text-[var(--bo-muted)]">{summary.source} · </span>
      <span className="font-medium text-[var(--bo-fg)]">{summary.eventType}</span>
    </span>
  );
}

function Headline({ headline }: { headline: string | null }) {
  return headline === null ? null : (
    <span className="truncate text-xs text-[var(--bo-fg)]" title={headline}>
      {headline}
    </span>
  );
}

function Effects({ effects }: { effects: readonly string[] }) {
  if (effects.length === 0) {
    return (
      <span className="min-w-0 flex-1 truncate text-[var(--bo-muted-2)]">Nothing acted on it</span>
    );
  }
  const text = effects.join(", ");
  return (
    <span className="min-w-0 flex-1 truncate text-[var(--bo-muted)]" title={text}>
      <span aria-hidden="true" className="text-[var(--bo-muted-2)]">
        →{" "}
      </span>
      {text}
    </span>
  );
}

function Clock({ at, precise }: { at: Date; precise: boolean }) {
  return (
    <time
      dateTime={at.toISOString()}
      title={momentFormat.format(at)}
      className={cn(
        "shrink-0 text-xs tabular-nums",
        precise ? "text-[var(--bo-muted)]" : "text-[var(--bo-muted-2)]",
      )}
    >
      {(precise ? preciseClockFormat : clockFormat).format(at)}
    </time>
  );
}

function rowClassName(current: boolean): string {
  return cn(
    "flex flex-col gap-1 rounded-[4px] px-3 py-2.5 transition-colors duration-150",
    current
      ? "bg-[var(--bo-accent-bg)]"
      : "hover:bg-[color-mix(in_srgb,var(--bo-accent-bg)_50%,transparent)]",
  );
}

function TraceList({
  entries,
  capped,
  openedTrace,
  selectedScope,
  now,
}: {
  entries: readonly EventTraceListEntry[];
  /** Whether older events exist beyond the latest ones the list holds. */
  capped: boolean;
  openedTrace: string | null;
  selectedScope: BackofficeScopeSelection;
  now: number;
}) {
  const scope = backofficeRouteScopeFromResolvedScope(selectedScope);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <section className="min-w-0">
      <header className={sectionHeaderClassName}>
        <h2 className={sectionTitleClassName}>Incoming events</h2>
      </header>
      <div className="backoffice-scroll max-h-[calc(100vh-14rem)] [scrollbar-gutter:stable] overflow-y-auto pb-1">
        {entriesByDay(entries, now).map((day) => (
          <section key={day.label} aria-label={day.label}>
            <h3 className="sticky top-0 z-[1] bg-[var(--bo-bg)] px-3 pt-3 pb-1 text-xs font-medium text-[var(--bo-muted-2)]">
              {day.label}
            </h3>
            <ul className="flex flex-col">
              {day.entries.map((entry) =>
                entry.kind === "trace" ? (
                  <li key={entry.trace.rootEventId}>
                    <TraceRow
                      summary={entry.trace}
                      opened={entry.trace.rootEventId === openedTrace}
                      scope={scope}
                    />
                  </li>
                ) : (
                  <li key={entry.id}>
                    <RepeatsRow
                      traces={entry.traces}
                      openedTrace={openedTrace}
                      expanded={expanded.has(entry.id)}
                      onToggle={() => {
                        toggle(entry.id);
                      }}
                      scope={scope}
                    />
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
        {capped ? (
          <p className="px-3 pt-3 text-xs text-[var(--bo-muted-2)]">
            Showing the latest {TRACE_LIMIT} events.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TraceRow({
  summary,
  opened,
  scope,
}: {
  summary: EventTraceSummary;
  opened: boolean;
  scope: BackofficeRouteScope;
}) {
  return (
    <Link
      to={dashboardEventsPath(scope, summary.rootEventId)}
      preventScrollReset
      aria-current={opened ? "page" : undefined}
      className={rowClassName(opened)}
    >
      <span className="flex items-baseline gap-2">
        <TraceLabel summary={summary} />
        <Clock at={summary.occurredAt} precise={false} />
      </span>
      <Headline headline={summary.headline} />
      <span className="flex min-h-6 items-center gap-2 text-xs">
        <Effects effects={summary.effects} />
        <TraceOutcome summary={summary} />
      </span>
    </Link>
  );
}

// Enough to see a pattern, such as a schedule failing every other minute, without wrapping.
const REPEAT_TICK_LIMIT = 30;

/** One origin repeating, such as a schedule: the newest first when expanded, oldest first as ticks. */
function RepeatsRow({
  traces,
  openedTrace,
  expanded,
  onToggle,
  scope,
}: {
  traces: readonly EventTraceSummary[];
  openedTrace: string | null;
  expanded: boolean;
  onToggle: () => void;
  scope: BackofficeRouteScope;
}) {
  const newest = traces[0];
  const oldest = traces.at(-1);
  if (newest === undefined || oldest === undefined) {
    return null;
  }
  const holdsOpened = traces.some((trace) => trace.rootEventId === openedTrace);
  const ticks = [...traces].reverse().slice(-REPEAT_TICK_LIMIT);
  const olderCount = traces.length - ticks.length;

  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          rowClassName(holdsOpened && !expanded),
          "w-full text-left focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none",
        )}
      >
        <span className="flex items-baseline gap-2">
          <TraceLabel summary={newest} />
          <span className="shrink-0 text-xs font-medium text-[var(--bo-muted)] tabular-nums">
            ×{traces.length}
          </span>
          {clockFormat.format(oldest.occurredAt) === clockFormat.format(newest.occurredAt) ? (
            <Clock at={newest.occurredAt} precise={false} />
          ) : (
            <span className="shrink-0 text-xs text-[var(--bo-muted-2)] tabular-nums">
              <Clock at={oldest.occurredAt} precise={false} />–
              <Clock at={newest.occurredAt} precise={false} />
            </span>
          )}
        </span>
        <Headline headline={newest.headline} />
        <span className="flex text-xs">
          <Effects effects={[...new Set(traces.flatMap((trace) => trace.effects))]} />
        </span>
        <span className="flex min-h-6 items-center gap-2">
          <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-[3px]">
            {olderCount === 0 ? null : (
              <span className="mr-1 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                +{olderCount}
              </span>
            )}
            {ticks.map((trace) => (
              <span
                key={trace.rootEventId}
                title={`${clockFormat.format(trace.occurredAt)} · ${TRACE_TONE_LABEL[traceTone(trace)]}`}
                // The opened trace stands taller, keeping its status colour.
                className={cn(
                  "w-1 shrink-0 rounded-full",
                  TRACE_TICK_CLASS[traceTone(trace)],
                  trace.rootEventId === openedTrace ? "h-4" : "h-2.5",
                )}
              />
            ))}
          </span>
          <RepeatsOutcome traces={traces} />
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--bo-muted)]">
            {expanded ? "Hide" : "Show"}
            <Icon
              name="chevron-down"
              aria-hidden="true"
              className={cn(
                "size-3 transition-transform duration-150 ease-out",
                expanded && "rotate-180",
              )}
            />
          </span>
        </span>
      </button>
      {expanded ? (
        <ul className="mb-1 ml-3 flex flex-col border-l border-[color:var(--bo-border)] pl-1">
          {traces.map((trace) => {
            const opened = trace.rootEventId === openedTrace;
            return (
              <li key={trace.rootEventId}>
                <Link
                  to={dashboardEventsPath(scope, trace.rootEventId)}
                  preventScrollReset
                  aria-current={opened ? "page" : undefined}
                  className={cn(rowClassName(opened), "py-1")}
                >
                  <span className="flex min-h-6 items-center gap-2 text-xs">
                    <Clock at={trace.occurredAt} precise />
                    <Effects effects={trace.effects} />
                    <TraceOutcome summary={trace} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

/**
 * The flame graph owns the trace's time: its replay cursor drives the selected run's step list too,
 * and the step under the pointer in that list is emphasized in the graph.
 */
function TraceView({
  trace,
  selectedScope,
  replica,
}: {
  trace: EventTrace;
  selectedScope: BackofficeScopeSelection;
  replica: LofiSqliteClient;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [cursor, setCursor] = useState<number | null>(null);
  const [hoveredStepRecordId, setHoveredStepRecordId] = useState<string | null>(null);
  const requestedId = dashboardSelectedTraceNode(searchParams);
  // A link to a node this trace does not hold shows the trace's origin instead.
  const selectedId =
    requestedId !== null && trace.records.has(requestedId) ? requestedId : trace.root.id;
  const path = causalFlamePath(trace.root, selectedId);
  const record = trace.records.get(selectedId) ?? null;

  function select(nodeId: string) {
    setSearchParams(
      (current) =>
        withSelectedTraceNode(current, trace.rootEventId, nodeId === trace.root.id ? null : nodeId),
      { replace: true, preventScrollReset: true },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <CausalFlameGraph
        title={trace.root.label}
        root={trace.root}
        selectedId={selectedId}
        emphasizedId={
          hoveredStepRecordId === null ? null : eventTraceStepNodeId(hoveredStepRecordId)
        }
        onSelect={(nodeId) => {
          select(nodeId ?? trace.root.id);
        }}
        cursor={cursor}
        onCursorChange={setCursor}
        replaySpeed={2}
        playWhenVisible={false}
        surface="flush"
      />
      {record === null ? null : (
        <TraceSelection
          path={path}
          record={record}
          cursor={cursor}
          selectedScope={selectedScope}
          replica={replica}
          onSelect={select}
          onHoverStepRecord={setHoveredStepRecordId}
        />
      )}
    </div>
  );
}

function TraceSelection({
  path,
  record,
  cursor,
  selectedScope,
  replica,
  onSelect,
  onHoverStepRecord,
}: {
  /** From the trace's origin down to the selected node. */
  path: readonly CausalFlameNode[];
  record: EventTraceRecord;
  cursor: number | null;
  selectedScope: BackofficeScopeSelection;
  replica: LofiSqliteClient;
  onSelect: (nodeId: string) => void;
  onHoverStepRecord: (stepRecordId: string | null) => void;
}) {
  const header = (actions: ReactNode) => (
    <header className={sectionHeaderClassName}>
      <SelectionTrail path={path} onSelect={onSelect} />
      <SelectionStatus node={path.at(-1) ?? null} cursor={cursor} />
      {actions === null ? null : (
        <span className="ml-auto flex shrink-0 items-center">{actions}</span>
      )}
    </header>
  );

  switch (record.kind) {
    case "event":
      return (
        <section className="min-w-0">
          {header(null)}
          <EventDetail event={record.event} node={path.at(-1) ?? null} onSelect={onSelect} />
        </section>
      );
    case "dispatch":
      return (
        <section className="min-w-0">
          {header(null)}
          <DispatchDetail dispatch={record.dispatch} />
        </section>
      );
    case "run":
      return (
        <RunSelection
          header={header}
          run={record.run}
          runNodeId={record.nodeId}
          selectedStepRecordId={null}
          cursor={cursor}
          selectedScope={selectedScope}
          replica={replica}
          onSelect={onSelect}
          onHoverStepRecord={onHoverStepRecord}
        />
      );
    case "step":
      return (
        <RunSelection
          header={header}
          run={record.run}
          runNodeId={record.runNodeId}
          selectedStepRecordId={record.step.id}
          cursor={cursor}
          selectedScope={selectedScope}
          replica={replica}
          onSelect={onSelect}
          onHoverStepRecord={onHoverStepRecord}
        />
      );
  }
  throw new Error("Unsupported event trace record.");
}

function RunSelection({
  header,
  run,
  runNodeId,
  selectedStepRecordId,
  cursor,
  selectedScope,
  replica,
  onSelect,
  onHoverStepRecord,
}: {
  header: (actions: ReactNode) => ReactNode;
  run: EventTraceRun;
  runNodeId: string;
  selectedStepRecordId: string | null;
  cursor: number | null;
  selectedScope: BackofficeScopeSelection;
  replica: LofiSqliteClient;
  onSelect: (nodeId: string) => void;
  onHoverStepRecord: (stepRecordId: string | null) => void;
}) {
  const reference = { workflowName: run.workflowName, instanceId: run.instanceId };
  return (
    <section className="min-w-0">
      {header(
        <Link
          to={dashboardRunPath(selectedScope, reference)}
          aria-label="Open on the overview"
          title="Open on the overview"
          className="inline-flex size-7 items-center justify-center rounded-[4px] text-[var(--bo-muted)] transition-colors duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
        >
          <Icon name="arrow-up-right" className="size-4" />
        </Link>,
      )}
      <Facts
        facts={[
          [
            "Run",
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-[12px]">{run.instanceId}</span>
              <CopyButton value={run.instanceId} label="Copy run id" text={null} />
            </span>,
          ],
          ["Created", formatTimestamp(run.createdAt)],
        ]}
      />
      <WorkflowRunDetail
        replica={replica}
        reference={reference}
        presentation={{
          kind: "embedded",
          cursor,
          selectedStepRecordId,
          // Deselecting a step goes back to the run that ran it.
          onSelectStepRecord: (stepRecordId) => {
            onSelect(stepRecordId === null ? runNodeId : eventTraceStepNodeId(stepRecordId));
          },
          onHoverStepRecord,
        }}
      />
    </section>
  );
}

/** The causal chain down to the selection; each ancestor selects itself. */
function SelectionTrail({
  path,
  onSelect,
}: {
  path: readonly CausalFlameNode[];
  onSelect: (nodeId: string) => void;
}) {
  return (
    <nav aria-label="Causal chain to the selection" className="flex min-w-0 items-center gap-1">
      {path.map((node, index) => (
        <Fragment key={node.id}>
          {index === 0 ? null : (
            <Icon name="chevron-right" className="size-3.5 shrink-0 text-[var(--bo-muted-2)]" />
          )}
          {index === path.length - 1 ? (
            <h2 aria-current="location" className={`min-w-0 truncate ${sectionTitleClassName}`}>
              {node.label}
            </h2>
          ) : (
            // Ancestors give way first, so the selection keeps its name.
            <button
              type="button"
              onClick={() => {
                onSelect(node.id);
              }}
              className="max-w-[14rem] min-w-[2.5rem] shrink-[4] truncate rounded-[3px] text-sm text-[var(--bo-muted)] transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
            >
              {node.label}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

const SELECTION_STATUS: Record<CausalFlameStatus, { tone: BackofficeStatusTone; label: string }> = {
  pending: { tone: "muted", label: "Pending" },
  running: { tone: "live", label: "Running" },
  waiting: { tone: "waiting", label: "Waiting" },
  ok: { tone: "muted", label: "Ok" },
  skipped: { tone: "muted", label: "Skipped" },
  failed: { tone: "failed", label: "Failed" },
};

const NOT_YET_STATUS = { tone: "muted", label: "Not yet" } as const;

/** Follows the replay, so the selection reads as it stood at the playhead. Events only happen. */
function SelectionStatus({
  node,
  cursor,
}: {
  node: CausalFlameNode | null;
  cursor: number | null;
}) {
  if (node === null || node.kind === "event") {
    return null;
  }
  const atCursor = cursor === null ? node : causalFlameNodeAt(node, cursor);
  const status = atCursor === null ? NOT_YET_STATUS : SELECTION_STATUS[atCursor.status];
  return <BackofficeStatusLight tone={status.tone}>{status.label}</BackofficeStatusLight>;
}

function Facts({ facts }: { facts: readonly [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 py-3 text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--bo-muted-2)]">{label}</dt>
          <dd className="min-w-0 break-words text-[var(--bo-fg)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function describeCausation(causation: AutomationEventCausation | null): string {
  if (causation === null || causation.kind === "origin") {
    return "Entered automations from outside";
  }
  if (causation.kind === "route") {
    return `Derived by route ${causation.routeId} from ${causation.parent.eventId}`;
  }
  return causation.parent === null
    ? `Fired by manually started run ${causation.instanceId}`
    : `Fired by run ${causation.instanceId}`;
}

function EventDetail({
  event,
  node,
  onSelect,
}: {
  event: EventTraceEvent;
  /** The event's node in the trace, whose route children are the routes it matched. */
  node: CausalFlameNode | null;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <>
      <Facts
        facts={[
          ["Event", <span className="font-mono text-[12px]">{event.id}</span>],
          ["Occurred", formatTimestamp(event.occurredAt)],
          ["Cause", describeCausation(event.causation)],
        ]}
      />
      <MatchedRoutes
        matching={!event.routesMatched}
        routes={(node?.children ?? []).filter((child) => child.kind === "route")}
        onSelect={onSelect}
      />
      <JsonBlock label="Payload" value={event.payload} />
      {event.subject === null ? null : <JsonBlock label="Subject" value={event.subject} />}
    </>
  );
}

/** Every route the event fanned out to, each with where it stands. */
function MatchedRoutes({
  matching,
  routes,
  onSelect,
}: {
  matching: boolean;
  routes: readonly CausalFlameNode[];
  onSelect: (nodeId: string) => void;
}) {
  return (
    <div className="mt-2 mb-4">
      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        {routes.length === 0 ? "Routes" : `Routes · ${routes.length}`}
      </p>
      {routes.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--bo-muted)]">
          {matching ? "Matching routes…" : "No route matched this event."}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)]">
          {routes.map((route) => {
            const status = SELECTION_STATUS[route.status];
            return (
              <li key={route.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(route.id);
                  }}
                  className="grid w-full grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_auto] items-baseline gap-x-4 py-2 text-left text-sm transition-colors duration-150 hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
                >
                  <span className="truncate font-medium text-[var(--bo-fg)]">{route.label}</span>
                  <span
                    className={cn(
                      "truncate text-xs",
                      route.status === "failed"
                        ? "text-[var(--bo-failed)]"
                        : "text-[var(--bo-muted)]",
                    )}
                    title={route.detail ?? undefined}
                  >
                    {route.detail}
                  </span>
                  <BackofficeStatusLight tone={status.tone}>{status.label}</BackofficeStatusLight>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function describeDispatchOutcome({ state }: EventTraceDispatch): string {
  if (state.status !== "completed") {
    return describeRouteDispatchProgress(state);
  }
  const { outcome } = state;
  switch (outcome.kind) {
    case "workflow_started":
      return `Started run ${outcome.instanceId}, which is no longer recorded`;
    case "workflow_event_sent":
      return `Delivered ${outcome.eventType} to run ${outcome.instanceId}`;
    case "event_forwarded":
      return `Forwarded the event as ${outcome.eventId}`;
    case "event_reclassified":
      return `Reclassified the event as ${outcome.eventId}`;
    case "agent_notified":
      return `Notified the ${outcome.agentName} agent`;
    case "skipped":
      return `Skipped: ${describeRouteDispatchSkipReason(outcome.reason)}`;
  }
  throw new Error("Unsupported automation route dispatch outcome.");
}

function DispatchDetail({ dispatch }: { dispatch: EventTraceDispatch }) {
  return (
    <>
      <DispatchFacts dispatch={dispatch} />
      {dispatch.state.status === "failed" ? <RetryRouteForm dispatch={dispatch} /> : null}
    </>
  );
}

function RetryRouteForm({ dispatch }: { dispatch: EventTraceDispatch }) {
  const fetcher = useFetcher<RouteRetryActionData>();
  const submitting = fetcher.state !== "idle";
  return (
    <fetcher.Form
      method="post"
      className="flex flex-col gap-2 border-t border-[color:var(--bo-border)] py-3"
    >
      <input type="hidden" name="intent" value="retry-route" />
      <input type="hidden" name="eventId" value={dispatch.eventId} />
      <input type="hidden" name="routeId" value={dispatch.routeId} />
      <p className="text-xs text-[var(--bo-muted)]">
        The route runs again as it was when the event matched it. Fix what it depends on first;
        changes to the route apply to new events.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" type="submit" disabled={submitting}>
          {submitting ? "Retrying…" : "Retry route"}
        </Button>
        {fetcher.data && !fetcher.data.ok ? (
          <span role="alert" className="text-xs text-[var(--bo-failed)]">
            {fetcher.data.message}
          </span>
        ) : null}
      </div>
    </fetcher.Form>
  );
}

function DispatchFacts({ dispatch }: { dispatch: EventTraceDispatch }) {
  return (
    <Facts
      facts={[
        ["Route", <span className="font-mono text-[12px]">{dispatch.routeId}</span>],
        ["Event", <span className="font-mono text-[12px]">{dispatch.eventId}</span>],
        ["Matched", formatTimestamp(dispatch.dispatchedAt)],
        ["Outcome", describeDispatchOutcome(dispatch)],
        ...(dispatch.state.status === "completed" && dispatch.state.failedAttempts > 0
          ? [
              [
                "Retries",
                `Acted after ${dispatch.state.failedAttempts} failed ${dispatch.state.failedAttempts === 1 ? "attempt" : "attempts"}`,
              ] as [string, ReactNode],
            ]
          : []),
      ]}
    />
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </p>
      <pre className="backoffice-scroll mt-1 max-h-80 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
