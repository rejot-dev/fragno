import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import { RunStatusLight } from "@fragno-private/backoffice-ui/run-status-light";
import { Icon } from "@fragno-private/design-system/icon";
import { ListRow, ListRowIcon, RowList } from "@fragno-private/design-system/list-row";
import {
  Panel,
  PanelFooter,
  PanelTable,
  PanelTableRow,
  panelRowTitleClassName,
} from "@fragno-private/design-system/panel";
import { formatRelativeTime } from "@fragno-private/design-system/relative-time";
import { SparkBars } from "@fragno-private/design-system/spark-bars";
import { StackedBarChart } from "@fragno-private/design-system/stacked-bar-chart";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { WorkflowRunGeneratedInterface } from "@/components/backoffice/workflow-run-generated-interface";
import type { AutomationReadSource } from "@/fragno/automation/read-source";

import {
  describePiAgentActivity,
  piAgentQueueStatus,
  type PiAgentListing,
} from "../agents/agent-activity";
import { piAgentsPath } from "../agents/path";
import { IntegrationConnectionStateLight } from "../integrations/connection-display";
import {
  integrationConnectionPath,
  integrationsScopeBasePath,
} from "../integrations/connection-paths";
import { OrchestrationPanel, type OrchestrationLoaderData } from "./orchestration-panel";
import type { BackofficeDashboard, DashboardAttention } from "./overview";
import {
  dashboardOpenedRun,
  dashboardPath,
  dashboardRunPath,
  dashboardSelectionPath,
} from "./path";
import { WorkflowRunDetail } from "./workflow-run-detail";

/** Sources beyond this many share one "other" series so the chart stays legible. */
const CHART_SOURCE_LIMIT = 5;
const OTHER_SOURCES = "other";
const COLLAPSED_WORKFLOW_COUNT = 8;
const WINDOW_LABEL = "24 hours";
// Clears the sticky top bar when an opened run scrolls the Automations panel into view.
const openedRunScrollMarginClassName = "scroll-mt-20";

export type DashboardLoaderData = OrchestrationLoaderData & { hasAgents: boolean };

export function DashboardSections({
  dashboard,
  now,
  loaderData,
  readSource,
  routes,
  recentEvents,
  agents,
}: {
  dashboard: BackofficeDashboard;
  now: number;
  loaderData: DashboardLoaderData;
  readSource: AutomationReadSource;
  routes: readonly AutomationRouteDefinition[];
  recentEvents: readonly { source: string; eventType: string }[];
  agents: readonly PiAgentListing[];
}) {
  const { selectedScope } = loaderData;
  const agentsPath = piAgentsPath(backofficeRouteScopeFromResolvedScope(selectedScope));

  return (
    <>
      <AttentionPanel attention={dashboard.attention} now={now} selectedScope={selectedScope} />

      <Panel title="Orchestration" leading={null} footer={null}>
        <OrchestrationPanel
          readSource={readSource}
          routes={routes}
          recentEvents={recentEvents}
          selectedScope={selectedScope}
          workflowSource={loaderData.workflowSource}
          runtimeToolCatalog={loaderData.runtimeToolCatalog}
        />
      </Panel>

      <div className="grid items-start gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-10">
          <WorkflowHealthPanel
            workflows={dashboard.workflows}
            now={now}
            selectedScope={selectedScope}
            readSource={readSource}
          />
          <EventVolumePanel eventVolume={dashboard.eventVolume} />
        </div>
        <div className="flex min-w-0 flex-col gap-10">
          <ConnectionsPanel dashboard={dashboard} now={now} selectedScope={selectedScope} />
          {dashboard.upcoming.length > 0 ? (
            <UpcomingPanel upcoming={dashboard.upcoming} now={now} selectedScope={selectedScope} />
          ) : null}
          {loaderData.hasAgents ? (
            <AgentsPanel agents={agents} now={now} agentsPath={agentsPath} />
          ) : null}
        </div>
      </div>
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
          trailing={<RowTime time={formatRelativeTime(item.run.updatedAt, now)} />}
          expansion={{
            label: "Respond",
            content: (
              <WorkflowRunGeneratedInterface
                run={{ ...item.run, steps: item.run.workflowSteps }}
                generatedUi={item.generatedUi}
                resolvedScope={selectedScope}
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

function WorkflowHealthPanel({
  workflows,
  now,
  selectedScope,
  readSource,
}: {
  workflows: BackofficeDashboard["workflows"];
  now: number;
  selectedScope: BackofficeScopeSelection;
  readSource: AutomationReadSource;
}) {
  const [showAll, setShowAll] = useState(false);
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

  if (openedRun) {
    return (
      <div ref={panelRef} className={`min-w-0 ${openedRunScrollMarginClassName}`}>
        <Panel
          title="Automations"
          leading={
            <BackLink to={dashboardPath(backofficeRouteScopeFromResolvedScope(selectedScope))} />
          }
          footer={null}
        >
          <WorkflowRunDetail
            key={openedRunKey}
            readSource={readSource}
            reference={openedRun}
            presentation={{ kind: "standalone" }}
          />
        </Panel>
      </div>
    );
  }

  const visibleWorkflows = showAll ? workflows : workflows.slice(0, COLLAPSED_WORKFLOW_COUNT);
  const footer =
    workflows.length > COLLAPSED_WORKFLOW_COUNT ? (
      <PanelFooter>
        <button
          type="button"
          onClick={() => {
            setShowAll((current) => !current);
          }}
          className="font-semibold text-[var(--bo-accent-fg)] hover:underline"
        >
          {showAll ? "Show recent workflows" : `Show all ${workflows.length} workflows`}
        </button>
      </PanelFooter>
    ) : null;
  return (
    <div ref={panelRef} className={`min-w-0 ${openedRunScrollMarginClassName}`}>
      <PanelTable
        title="Automations"
        columns={workflowColumns}
        empty="No workflow has run in this scope yet."
        footer={footer}
      >
        {visibleWorkflows.map((workflow) => {
          const finished = workflow.completedRuns + workflow.erroredRuns;
          return (
            <PanelTableRow
              key={workflow.workflow}
              columns={workflowColumns}
              title={
                <Link
                  to={dashboardRunPath(selectedScope, workflow.latestRun)}
                  preventScrollReset
                  className={panelRowTitleClassName}
                  title={workflow.workflow}
                >
                  {workflow.workflow}
                </Link>
              }
              cells={[
                <>
                  <SparkBars
                    values={workflow.startsPerBucket}
                    ariaLabel={`${workflow.workflow} runs over the last ${WINDOW_LABEL}`}
                  />
                  <span className="text-[var(--bo-muted)] tabular-nums">
                    {workflow.startedRuns}
                  </span>
                </>,
                finished === 0 ? (
                  <span className="text-[var(--bo-muted-2)]">—</span>
                ) : (
                  <span
                    className={`tabular-nums ${workflow.erroredRuns > 0 ? "text-[var(--bo-failed)]" : "text-[var(--bo-live)]"}`}
                  >
                    {Math.round((workflow.completedRuns / finished) * 100)}%
                  </span>
                ),
                <>
                  <RunStatusLight status={workflow.latestRun.status} />
                  <span className="w-16 text-right text-xs text-[var(--bo-muted-2)] tabular-nums">
                    {formatRelativeTime(workflow.latestRun.updatedAt, now)}
                  </span>
                </>,
              ]}
            />
          );
        })}
      </PanelTable>
    </div>
  );
}

const workflowColumns = [
  { label: `Runs · ${WINDOW_LABEL}`, align: "start" },
  { label: "Success", align: "end" },
  { label: "Last run", align: "end" },
] as const;

// Buckets carry their date because a day-long window starts and ends at the same hour.
const bucketLabelFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function EventVolumePanel({ eventVolume }: { eventVolume: BackofficeDashboard["eventVolume"] }) {
  const charted = eventVolume.sources.slice(0, CHART_SOURCE_LIMIT).map(({ source }) => source);
  const hasOther = eventVolume.sources.length > CHART_SOURCE_LIMIT;
  const series = [...charted, ...(hasOther ? [OTHER_SOURCES] : [])].map((id) => ({
    id,
    label: id,
  }));
  const buckets = eventVolume.bucketStarts.map((start, index) => {
    const counts = eventVolume.countsByBucket[index] ?? {};
    const values: Record<string, number> = {};
    for (const [source, count] of Object.entries(counts)) {
      const seriesId = charted.includes(source) ? source : OTHER_SOURCES;
      values[seriesId] = (values[seriesId] ?? 0) + count;
    }
    return {
      id: String(start),
      label: `${bucketLabelFormat.format(start)} UTC`,
      values,
    };
  });

  return (
    <Panel title="Events" leading={null} footer={null}>
      <div className="py-4">
        {eventVolume.sources.length === 0 ? (
          <p className="text-sm text-[var(--bo-muted)]">
            No events arrived in the last {WINDOW_LABEL}.
          </p>
        ) : (
          <StackedBarChart
            series={series}
            buckets={buckets}
            ariaLabel={`Events per source over the last ${WINDOW_LABEL}`}
          />
        )}
      </div>
    </Panel>
  );
}

function ConnectionsPanel({
  dashboard,
  now,
  selectedScope,
}: {
  dashboard: BackofficeDashboard;
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  return (
    <Panel
      title="Connections"
      leading={null}
      footer={<ShowMoreFooter to={integrationsScopeBasePath(selectedScope)} page="Integrations" />}
    >
      <RowList empty="No connections yet. Ask your agent to add one.">
        {dashboard.connections.map((connection) => (
          <ListRow
            key={connection.connectionId}
            to={integrationConnectionPath(selectedScope, connection.connectionId)}
            leading={null}
            title={connection.displayName}
            detail={`${connection.kindLabel} · ${formatRelativeTime(connection.changedAt, now)}`}
            trailing={<IntegrationConnectionStateLight state={connection.state} />}
            expansion={null}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function UpcomingPanel({
  upcoming,
  now,
  selectedScope,
}: {
  upcoming: BackofficeDashboard["upcoming"];
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  return (
    <Panel title="Scheduled & waiting" leading={null} footer={null}>
      <RowList empty={null}>
        {upcoming.map((entry) =>
          entry.kind === "schedule" ? (
            <ListRow
              key={`schedule:${entry.routeId}`}
              to={dashboardSelectionPath(selectedScope, { kind: "route", id: entry.routeId })}
              leading={<ListRowIcon name="clock" tone={null} />}
              title={entry.name}
              detail="Scheduled route"
              trailing={<RowTime time={formatRelativeTime(entry.at, now)} />}
              expansion={null}
            />
          ) : (
            <ListRow
              key={`run:${entry.run.workflowName}:${entry.run.instanceId}`}
              to={dashboardRunPath(selectedScope, entry.run)}
              leading={<ListRowIcon name="pause-circle" tone={null} />}
              title={entry.workflow}
              detail={
                entry.waitingFor.length > 0
                  ? `Waiting for ${entry.waitingFor.join(", ")}`
                  : "Waiting"
              }
              trailing={<RowTime time={formatRelativeTime(entry.run.updatedAt, now)} />}
              expansion={null}
            />
          ),
        )}
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
