import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { ListRow, ListRowIcon, RowList } from "@fragno-private/design-system/data/list-row";
import { formatRelativeTime } from "@fragno-private/design-system/data/relative-time";
import { SparkBars } from "@fragno-private/design-system/data/spark-bars";
import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/feedback/status-tone";
import { Icon } from "@fragno-private/design-system/icon";
import { Panel, PanelFooter } from "@fragno-private/design-system/layout/panel";
import { Link } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { useAskAgent } from "@/components/backoffice/ask-agent";
import { MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";

import {
  describePiAgentActivity,
  piAgentQueueStatus,
  type PiAgentListing,
} from "../agents/agent-activity";
import { piAgentsPath } from "../agents/path";
import { WorkflowRunCard } from "../agents/session-detail/session-workflow";
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
  dashboardRunPath,
  dashboardSelectionPath,
  dashboardWorkflowsPath,
} from "./path";

const WINDOW_LABEL = "24 hours";

export type DashboardLoaderData = { selectedScope: BackofficeScopeSelection; hasAgents: boolean };

/**
 * The scope's overview: what needs a person, what is coming up, what agents are doing, and what
 * automations did lately. How it is wired lives on the Map, and everything it did on Activity.
 */
export function DashboardSections({
  dashboard,
  now,
  loaderData,
  recentActivity,
  agents,
}: {
  dashboard: BackofficeDashboard;
  now: number;
  loaderData: DashboardLoaderData;
  /** The latest traces that set something in motion, in list order. */
  recentActivity: readonly EventTraceListEntry[];
  agents: readonly PiAgentListing[];
}) {
  const { selectedScope } = loaderData;
  const agentsPath = piAgentsPath(backofficeRouteScopeFromResolvedScope(selectedScope));

  return (
    <>
      <AttentionPanel attention={dashboard.attention} now={now} selectedScope={selectedScope} />
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
    // The run shows what it asks right here, as its card in a conversation does.
    case "awaiting-input":
      return (
        <li className="py-3">
          <WorkflowRunCard
            run={item.run}
            nameTo={dashboardRunPath(selectedScope, item.run)}
            actions={<ConversationLink run={item.run} selectedScope={selectedScope} />}
          />
        </li>
      );
    case "failing-workflow":
      return (
        <ListRow
          to={dashboardWorkflowsPath(backofficeRouteScopeFromResolvedScope(selectedScope), {
            scriptPath: null,
            filter: { kind: "failed" },
            run: {
              workflowName: item.latestRun.workflowName,
              instanceId: item.latestRun.instanceId,
              stepRecordId: null,
            },
          })}
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
          actions={<InvestigateButton item={item} />}
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
          actions={null}
          expansion={null}
        />
      );
  }
  throw new Error("Unsupported dashboard attention item.");
}

/** The conversation whose agent started a run waiting for input, when an agent did. */
function ConversationLink({
  run,
  selectedScope,
}: {
  run: AutomationWorkflowRun;
  selectedScope: BackofficeScopeSelection;
}) {
  const agentName = run.codemode?.agentName ?? null;
  if (agentName === null) {
    return null;
  }
  return (
    <ButtonLink
      variant="ghost"
      to={`${piAgentsPath(backofficeRouteScopeFromResolvedScope(selectedScope))}/${encodeURIComponent(agentName)}`}
      className="min-h-8 px-2 text-xs text-[var(--bo-muted)]"
    >
      <Icon name="message-square" className="size-3.5" />
      Conversation
    </ButtonLink>
  );
}

/**
 * Opens the assistant with a request to find out why a workflow fails, ready for the person to
 * add what they know and send.
 */
function InvestigateButton({
  item,
}: {
  item: Extract<DashboardAttention, { kind: "failing-workflow" }>;
}) {
  const askAgent = useAskAgent();
  if (askAgent === null) {
    return null;
  }
  const runs = item.erroredRuns === 1 ? "once" : `${item.erroredRuns} times`;
  const error = item.error === null ? "" : ` It failed with "${item.error}".`;
  return (
    <Button
      variant="ghost"
      onClick={() => {
        askAgent({
          agentName: MAIN_PI_AGENT_NAME,
          text: `The workflow ${item.workflow} failed ${runs} since it last completed. Its latest failed run is ${item.latestRun.instanceId}.${error}

Investigate why it fails: look at its failed runs, the steps they failed at, and the workflow's source. Tell me the cause and how to fix it.`,
        });
      }}
      // The agent drawer only opens from the sm breakpoint up.
      className="hidden min-h-8 px-2 text-xs text-[var(--bo-muted)] sm:inline-flex"
    >
      <Icon name="search" className="size-3.5" />
      Investigate
    </Button>
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
            actions={null}
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
            actions={null}
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
              actions={null}
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
              actions={null}
              expansion={null}
            />
          );
        })}
      </RowList>
    </Panel>
  );
}
