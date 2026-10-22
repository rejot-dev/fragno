import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import { RunStatusLight } from "@fragno-private/backoffice-ui/run-status-light";
import { Icon, type IconName } from "@fragno-private/design-system/icon";
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { WorkflowRunGeneratedInterface } from "@/components/backoffice/workflow-run-generated-interface";
import type { AutomationBrowserCollections } from "@/fragno/automation/tanstack/browser-database";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";

import {
  describePiAgentActivity,
  piAgentQueueStatus,
  type PiAgentListing,
} from "../agents/agent-activity";
import { piAgentsPath } from "../agents/path";
import type { AutomationScriptSourceRecord } from "../automations/data";
import { IntegrationConnectionStateLight } from "../integrations/connection-display";
import {
  integrationConnectionPath,
  integrationsScopeBasePath,
} from "../integrations/connection-paths";
import { OrchestrationPanel } from "./orchestration-panel";
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

export type DashboardLoaderData = {
  selectedScope: BackofficeScopeSelection;
  hasAgents: boolean;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
};

export function DashboardSections({
  dashboard,
  now,
  loaderData,
  collections,
  routes,
  recentEvents,
  agents,
}: {
  dashboard: BackofficeDashboard;
  now: number;
  loaderData: DashboardLoaderData;
  collections: AutomationBrowserCollections;
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
          collections={collections}
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
            collections={collections}
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

function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="font-semibold whitespace-nowrap text-[var(--bo-accent-fg)] hover:underline"
    >
      {children}
    </Link>
  );
}

const attentionTiles = {
  "awaiting-input": {
    icon: "edit-3",
    className: "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]",
  },
  "failing-workflow": {
    icon: "alert-triangle",
    className: "bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]",
  },
  "connection-unavailable": {
    icon: "link",
    className: "bg-[var(--bo-waiting-bg)] text-[var(--bo-waiting)]",
  },
} as const satisfies Record<DashboardAttention["kind"], { icon: IconName; className: string }>;

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
      {attention.length === 0 ? (
        <p className="flex items-center gap-2 py-5 text-sm text-[var(--bo-muted)]">
          <Icon name="check" className="size-4 text-[var(--bo-live)]" />
          Nothing needs attention. Runs are healthy and every connection is ready.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--bo-border)]">
          {attention.map((item) => (
            <li key={attentionKey(item)} className="py-3">
              <AttentionItem item={item} now={now} selectedScope={selectedScope} />
            </li>
          ))}
        </ul>
      )}
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

function AttentionItem({
  item,
  now,
  selectedScope,
}: {
  item: DashboardAttention;
  now: number;
  selectedScope: BackofficeScopeSelection;
}) {
  const tile = attentionTiles[item.kind];
  const row = (title: string, detail: ReactNode, time: Date | string, action: ReactNode) => (
    <div className="flex items-start gap-3">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-[4px] ${tile.className}`}
      >
        <Icon name={tile.icon} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">{title}</p>
        <div className="mt-0.5 text-xs text-[var(--bo-muted)]">{detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-4 text-xs">
        <span className="text-[var(--bo-muted-2)] tabular-nums">
          {formatRelativeTime(time, now)}
        </span>
        {action}
      </div>
    </div>
  );

  switch (item.kind) {
    case "awaiting-input":
      return (
        <details className="group">
          <summary className="cursor-pointer list-none marker:content-none">
            {row(
              item.workflow,
              "Waiting for your input",
              item.run.updatedAt,
              <>
                <span className="inline-flex items-center gap-1 font-semibold text-[var(--bo-accent-fg)]">
                  Respond
                  <Icon
                    name="chevron-down"
                    className="size-3.5 transition-transform group-open:rotate-180"
                  />
                </span>
                <TextLink to={dashboardRunPath(selectedScope, item.run)}>Open run</TextLink>
              </>,
            )}
          </summary>
          <div className="mt-3 ml-11">
            <WorkflowRunGeneratedInterface
              run={{ ...item.run, steps: item.run.workflowSteps }}
              generatedUi={item.generatedUi}
              resolvedScope={selectedScope}
            />
          </div>
        </details>
      );
    case "failing-workflow":
      return row(
        item.workflow,
        <>
          <span className="font-semibold text-[var(--bo-failed)]">
            {item.erroredRuns} errored {item.erroredRuns === 1 ? "run" : "runs"}
          </span>
          {item.error ? (
            <span className="mt-0.5 block truncate font-mono text-[11px]" title={item.error}>
              {item.error}
            </span>
          ) : null}
        </>,
        item.latestRun.updatedAt,
        <TextLink to={dashboardRunPath(selectedScope, item.latestRun)}>Latest run</TextLink>,
      );
    case "connection-unavailable":
      return row(
        item.connection.displayName,
        <>
          {item.connection.kindLabel} connection is unavailable ·{" "}
          <span className="font-mono">{item.connection.connectionId}</span>
        </>,
        item.connection.changedAt,
        <TextLink to={integrationConnectionPath(selectedScope, item.connection.connectionId)}>
          Fix
        </TextLink>,
      );
  }
  throw new Error("Unsupported dashboard attention item.");
}

function WorkflowHealthPanel({
  workflows,
  now,
  selectedScope,
  collections,
}: {
  workflows: BackofficeDashboard["workflows"];
  now: number;
  selectedScope: BackofficeScopeSelection;
  collections: AutomationBrowserCollections;
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
            collections={collections}
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
              trailing={<UpcomingTime time={formatRelativeTime(entry.at, now)} />}
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
              trailing={<UpcomingTime time={formatRelativeTime(entry.run.updatedAt, now)} />}
            />
          ),
        )}
      </RowList>
    </Panel>
  );
}

function UpcomingTime({ time }: { time: string }) {
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
            />
          );
        })}
      </RowList>
    </Panel>
  );
}
