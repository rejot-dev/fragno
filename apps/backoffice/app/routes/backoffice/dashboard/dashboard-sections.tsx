import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { ListRow, ListRowIcon, RowList } from "@fragno-private/design-system/list-row";
import { Panel, PanelFooter } from "@fragno-private/design-system/panel";
import { formatRelativeTime } from "@fragno-private/design-system/relative-time";
import { RunStopControl } from "@fragno-private/design-system/run-stop-control";
import { SparkBars } from "@fragno-private/design-system/spark-bars";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";
import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { terminateBackofficeWorkflowRun } from "@/backoffice-ui/workflow-events.client";
import { WorkflowRunGeneratedInterface } from "@/components/backoffice/workflow-run-generated-interface";

import {
  describePiAgentActivity,
  piAgentQueueStatus,
  type PiAgentListing,
} from "../agents/agent-activity";
import { piAgentsPath } from "../agents/path";
import type { AutomationWorkflowRun } from "../automations/script-view/workflow-run-presentation";
import { integrationConnectionPath } from "../integrations/connection-paths";
import {
  RepeatsOutcome,
  TraceOutcome,
  describeTraceEffects,
  describeTraceTrigger,
  traceEffectsIcon,
} from "./activity-parts";
import type { EventTraceListEntry, EventTraceSummary } from "./event-traces";
import type { BackofficeDashboard, DashboardAttention } from "./overview";
import {
  dashboardActivityPath,
  dashboardOpenedRun,
  dashboardPath,
  dashboardRunPath,
  dashboardSelectionPath,
} from "./path";
import { WorkflowRunDetail } from "./workflow-run-detail";

const WINDOW_LABEL = "24 hours";
// Clears the sticky top bar when an opened run scrolls into view.
const openedRunScrollMarginClassName = "scroll-mt-20";

export type DashboardLoaderData = { selectedScope: BackofficeScopeSelection; hasAgents: boolean };

/**
 * The scope's overview: what needs a person, what is coming up, what agents are doing, and what
 * automations did lately. How it is wired lives on the Map, and everything it did on Activity.
 */
export function DashboardSections({
  dashboard,
  now,
  loaderData,
  replica,
  recentActivity,
  agents,
}: {
  dashboard: BackofficeDashboard;
  now: number;
  loaderData: DashboardLoaderData;
  replica: LofiSqliteClient;
  /** The latest traces that set something in motion, in list order. */
  recentActivity: readonly EventTraceListEntry[];
  agents: readonly PiAgentListing[];
}) {
  const { selectedScope } = loaderData;
  const agentsPath = piAgentsPath(backofficeRouteScopeFromResolvedScope(selectedScope));

  return (
    <>
      <AttentionPanel attention={dashboard.attention} now={now} selectedScope={selectedScope} />
      <OpenedRunPanel selectedScope={selectedScope} replica={replica} />
      <div className="grid items-start gap-x-12 gap-y-10 lg:grid-cols-2">
        <ComingUpPanel dashboard={dashboard} now={now} selectedScope={selectedScope} />
        {loaderData.hasAgents ? (
          <AgentsPanel agents={agents} now={now} agentsPath={agentsPath} />
        ) : null}
      </div>
      <RecentActivityPanel entries={recentActivity} now={now} selectedScope={selectedScope} />
    </>
  );
}

/** Leads back from the detail a panel shows. */
function BackLink({ to }: { to: string }) {
  return (
    <Link
      to={to}
      preventScrollReset
      aria-label="Back"
      title="Back"
      className="-ml-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-[4px] text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]"
    >
      <Icon name="arrow-left" className="size-4" />
    </Link>
  );
}

/** The panel's last row, which leads to the page that shows everything the panel summarizes. */
function ShowMoreFooter({ to, page }: { to: string; page: string }) {
  return (
    <PanelFooter>
      <Link to={to} className="font-semibold text-[var(--bo-accent-fg)] hover:underline">
        Show more on the {page} page
      </Link>
    </PanelFooter>
  );
}

function AttentionPanel({
  attention,
  now,
  selectedScope,
}: {
  attention: readonly DashboardAttention[];
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  return (
    <Panel title="Needs attention" leading={null} footer={null}>
      <RowList
        empty={
          <span className="flex items-center gap-2">
            <Icon name="check" className="size-4 text-[var(--bo-live)]" />
            Nothing needs attention. Runs are healthy and every connection is ready.
          </span>
        }
      >
        {attention.map((item) => (
          <AttentionRow
            key={attentionKey(item)}
            item={item}
            now={now}
            selectedScope={selectedScope}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function attentionKey(item: DashboardAttention) {
  switch (item.kind) {
    case "awaiting-input":
      return `input:${item.run.id}`;
    case "failing-workflow":
      return `failing:${item.workflow}`;
    case "connection-unavailable":
      return `connection:${item.connection.connectionId}`;
  }
  throw new Error("Unsupported dashboard attention item.");
}

function AttentionRow({
  item,
  now,
  selectedScope,
}: {
  item: DashboardAttention;
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  switch (item.kind) {
    case "awaiting-input":
      return (
        <ListRow
          to={dashboardRunPath(selectedScope, item.run)}
          leading={<ListRowIcon name="edit-3" tone="info" />}
          title={item.workflow}
          detail="Waiting for your input"
          trailing={
            <>
              <AwaitingInputActions run={item.run} selectedScope={selectedScope} />
              <RowTime time={formatRelativeTime(item.run.updatedAt, now)} />
            </>
          }
          expansion={{
            label: "Respond",
            content: (
              <WorkflowRunGeneratedInterface
                run={{ ...item.run, steps: item.run.workflowSteps }}
                generatedUi={item.generatedUi}
                resolvedScope={selectedScope}
                standalone={false}
              />
            ),
          }}
        />
      );
    case "failing-workflow":
      return (
        <ListRow
          to={dashboardRunPath(selectedScope, item.latestRun)}
          leading={<ListRowIcon name="alert-triangle" tone="failed" />}
          title={item.workflow}
          detail={item.error ?? "Errored"}
          trailing={
            <>
              <BackofficeStatusLight tone="failed" dot={false}>
                {item.erroredRuns} errored {item.erroredRuns === 1 ? "run" : "runs"}
              </BackofficeStatusLight>
              <RowTime time={formatRelativeTime(item.latestRun.updatedAt, now)} />
            </>
          }
          expansion={null}
        />
      );
    case "connection-unavailable":
      return (
        <ListRow
          to={integrationConnectionPath(selectedScope, item.connection.connectionId)}
          leading={<ListRowIcon name="link" tone="waiting" />}
          title={item.connection.displayName}
          detail={`${item.connection.kindLabel} connection is unavailable`}
          trailing={<RowTime time={formatRelativeTime(item.connection.changedAt, now)} />}
          expansion={null}
        />
      );
  }
  throw new Error("Unsupported dashboard attention item.");
}

/**
 * What a person can do about a run waiting for them besides answering it: open the conversation
 * whose agent started it, or stop it, as its card in that conversation does.
 */
function AwaitingInputActions({
  run,
  selectedScope,
}: {
  run: AutomationWorkflowRun;
  selectedScope: BackofficeScopeSelection;
}) {
  const agentName = run.codemode?.agentName ?? null;
  return (
    <>
      {agentName === null ? null : (
        <ButtonLink
          variant="ghost"
          to={`${piAgentsPath(backofficeRouteScopeFromResolvedScope(selectedScope))}/${encodeURIComponent(agentName)}`}
          className="min-h-8 px-2 text-xs text-[var(--bo-muted)]"
        >
          <Icon name="message-square" className="size-3.5" />
          Conversation
        </ButtonLink>
      )}
      <RunStopControl
        onStop={() =>
          terminateBackofficeWorkflowRun({
            scope: backofficeRuntimeScopeFromResolvedScope(selectedScope),
            workflowName: run.workflowName,
            instanceId: run.instanceId,
          })
        }
      />
    </>
  );
}

/** The run a link elsewhere on the page or beyond it opened, above everything but what needs a person. */
function OpenedRunPanel({
  selectedScope,
  replica,
}: {
  selectedScope: BackofficeScopeSelection;
  replica: LofiSqliteClient;
}) {
  const [searchParams] = useSearchParams();
  const openedRun = dashboardOpenedRun(searchParams);
  const openedRunKey = openedRun ? `${openedRun.workflowName}:${openedRun.instanceId}` : null;
  const panelRef = useRef<HTMLDivElement>(null);
  // Runs open from links anywhere on the page, so bring the panel that shows them into view.
  useEffect(() => {
    if (openedRunKey !== null) {
      panelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [openedRunKey]);

  if (openedRun === null) {
    return null;
  }
  return (
    <div ref={panelRef} className={`min-w-0 ${openedRunScrollMarginClassName}`}>
      <Panel
        title="Run"
        leading={
          <BackLink to={dashboardPath(backofficeRouteScopeFromResolvedScope(selectedScope))} />
        }
        footer={null}
      >
        <WorkflowRunDetail
          key={openedRunKey}
          replica={replica}
          reference={openedRun}
          presentation={{ kind: "standalone" }}
        />
      </Panel>
    </div>
  );
}

/** Schedules that fire next, then runs that wait for an event without asking anyone. */
function ComingUpPanel({
  dashboard,
  now,
  selectedScope,
}: {
  dashboard: BackofficeDashboard;
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  return (
    <Panel title="Coming up" leading={null} footer={null}>
      <RowList empty="Nothing is scheduled. Ask an agent to run something on a schedule, such as a summary every morning.">
        {dashboard.schedules.map((schedule) => (
          <ListRow
            key={`schedule:${schedule.routeId}`}
            to={dashboardSelectionPath(selectedScope, { kind: "route", id: schedule.routeId })}
            leading={<ListRowIcon name="calendar" tone={null} />}
            title={schedule.name}
            detail={schedule.cadence}
            trailing={<RowTime time={formatRelativeTime(schedule.at, now)} />}
            expansion={null}
          />
        ))}
        {dashboard.waiting.map((entry) => (
          <ListRow
            key={`waiting:${entry.workflow}`}
            to={dashboardRunPath(selectedScope, entry.latestRun)}
            leading={<ListRowIcon name="pause-circle" tone={null} />}
            title={entry.workflow}
            detail={describeWaiting(entry.runCount, entry.waitingFor)}
            trailing={<RowTime time={formatRelativeTime(entry.latestRun.updatedAt, now)} />}
            expansion={null}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function describeWaiting(runCount: number, waitingFor: readonly string[]): string {
  const runs = runCount === 1 ? "Waiting" : `${runCount} runs waiting`;
  return waitingFor.length === 0 ? runs : `${runs} for ${waitingFor.join(", ")}`;
}

const RECENT_ACTIVITY_ROWS = 6;

/** Every row's icon sits in a toned box, so titles line up whether or not the row needs a look. */
function outcomeTone(summaries: readonly EventTraceSummary[]): BackofficeStatusTone {
  const outcomes = summaries.map((summary) => summary.outcome);
  if (outcomes.some((outcome) => outcome.kind !== "unhandled" && outcome.failedCount > 0)) {
    return "failed";
  }
  if (outcomes.some((outcome) => outcome.kind === "in_progress")) {
    return outcomes.some((outcome) => outcome.kind === "in_progress" && outcome.state === "running")
      ? "live"
      : "waiting";
  }
  return "muted";
}

/** What automations did lately, each led by what it did and followed by what set it off. */
function RecentActivityPanel({
  entries,
  now,
  selectedScope,
}: {
  entries: readonly EventTraceListEntry[];
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  const scope = backofficeRouteScopeFromResolvedScope(selectedScope);
  return (
    <Panel
      title="Recent activity"
      leading={null}
      footer={
        <ShowMoreFooter
          to={dashboardActivityPath(scope, { trace: null, filter: "all" })}
          page="Activity"
        />
      }
    >
      <RowList empty="Nothing has happened yet. When a schedule fires, or an event starts a workflow or reaches an agent, it shows here.">
        {entries.slice(0, RECENT_ACTIVITY_ROWS).map((entry) => {
          const traces = entry.kind === "trace" ? [entry.trace] : entry.traces;
          const newest = traces[0];
          if (newest === undefined) {
            return null;
          }
          const effects = traces.flatMap((trace) => trace.effects);
          const repeated = traces.length > 1 ? ` ×${traces.length}` : "";
          return (
            <ListRow
              key={newest.rootEventId}
              to={dashboardActivityPath(scope, { trace: newest.rootEventId, filter: "all" })}
              leading={<ListRowIcon name={traceEffectsIcon(effects)} tone={outcomeTone(traces)} />}
              title={`${describeTraceEffects(newest.effects)}${repeated}`}
              detail={describeTraceTrigger(newest)}
              trailing={
                <>
                  {traces.length > 1 ? (
                    <RepeatsOutcome traces={traces} />
                  ) : (
                    <TraceOutcome summary={newest} />
                  )}
                  <RowTime time={formatRelativeTime(newest.occurredAt, now)} />
                </>
              }
              expansion={null}
            />
          );
        })}
      </RowList>
    </Panel>
  );
}

function RowTime({ time }: { time: string }) {
  return <span className="text-[var(--bo-muted-2)] tabular-nums">{time}</span>;
}

function AgentsPanel({
  agents,
  now,
  agentsPath,
}: {
  agents: readonly PiAgentListing[];
  now: number;
  agentsPath: string;
}) {
  return (
    <Panel title="Agents" leading={null} footer={<ShowMoreFooter to={agentsPath} page="Agents" />}>
      <RowList empty={null}>
        {agents.map((agent) => {
          const queue = piAgentQueueStatus(agent);
          const turns = agent.turnsPerBucket.reduce((total, count) => total + count, 0);
          return (
            <ListRow
              key={agent.agentName}
              to={`${agentsPath}/${encodeURIComponent(agent.agentName)}`}
              leading={<ListRowIcon name="message-square" tone={null} />}
              title={agent.displayName}
              detail={
                <span className={agent.answering ? "text-[var(--bo-live)]" : undefined}>
                  {describePiAgentActivity(agent, now)}
                </span>
              }
              trailing={
                <>
                  {queue ? (
                    <BackofficeStatusLight tone={queue.tone} dot={false} role="status">
                      {queue.label}
                    </BackofficeStatusLight>
                  ) : null}
                  {agent.latestAt !== null ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <SparkBars
                        values={agent.turnsPerBucket}
                        ariaLabel={`${agent.displayName} turns over the last ${WINDOW_LABEL}`}
                      />
                      <span className="w-6 text-right text-xs text-[var(--bo-muted)] tabular-nums">
                        {turns}
                      </span>
                    </span>
                  ) : null}
                </>
              }
              expansion={null}
            />
          );
        })}
      </RowList>
    </Panel>
  );
}
