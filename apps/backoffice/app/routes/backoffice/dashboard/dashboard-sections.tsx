import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import { Icon, type IconName } from "@fragno-private/design-system/icon";
import { SparkBars } from "@fragno-private/design-system/spark-bars";
import { StackedBarChart } from "@fragno-private/design-system/stacked-bar-chart";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";
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
import { formatPiAgentName } from "../agents/agent-name";
import { piAgentsPath } from "../agents/path";
import type { AutomationScriptSourceRecord } from "../automations/data";
import { formatRelativeTime } from "../automations/formatting";
import {
  IntegrationConnectionStateLight,
  describeIntegrationConnectionKind,
  integrationConnectionName,
} from "../integrations/connection-display";
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

      <Panel title="Orchestration" back={null} footer={null}>
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

// Sections are a titled rule over their content rather than cards, so the page stays flat.
const sectionHeaderClassName =
  "flex h-9 items-center gap-2 border-b border-[color:var(--bo-border)]";
const sectionTitleClassName = "text-sm font-semibold text-[var(--bo-fg)]";
const columnLabelClassName =
  "text-[10px] font-normal tracking-[0.2em] text-[var(--bo-muted-2)] uppercase";

function Panel({
  title,
  back,
  footer,
  children,
}: {
  title: string;
  /** Where the header's back button leads while the panel shows a detail. */
  back: string | null;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <header className={sectionHeaderClassName}>
        {back === null ? null : (
          <Link
            to={back}
            preventScrollReset
            aria-label="Back"
            title="Back"
            className="-ml-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-[4px] text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]"
          >
            <Icon name="arrow-left" className="size-4" />
          </Link>
        )}
        <h2 className={sectionTitleClassName}>{title}</h2>
      </header>
      {children}
      {footer}
    </section>
  );
}

const panelFooterClassName =
  "flex items-center gap-4 border-t border-[color:var(--bo-border)] py-2 text-xs";

/** The panel's last row, which leads to the page that shows everything the panel summarizes. */
function PanelFooter({ to, page }: { to: string; page: string }) {
  return (
    <div className={panelFooterClassName}>
      <Link to={to} className="ml-auto font-semibold text-[var(--bo-accent-fg)] hover:underline">
        Show more on the {page} page
      </Link>
    </div>
  );
}

function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="py-5 text-sm text-pretty text-[var(--bo-muted)]">{children}</p>;
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
    <Panel title="Needs attention" back={null} footer={null}>
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
        integrationConnectionName(item.connection),
        <>
          {describeIntegrationConnectionKind(item.connection)} connection is unavailable ·{" "}
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

const runStatusLights = {
  active: { label: "Running", tone: "info" },
  paused: { label: "Paused", tone: "waiting" },
  waiting: { label: "Waiting", tone: "waiting" },
  complete: { label: "Complete", tone: "live" },
  errored: { label: "Errored", tone: "failed" },
  terminated: { label: "Terminated", tone: "muted" },
} as const satisfies Record<WorkflowInstanceStatus, { label: string; tone: BackofficeStatusTone }>;

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
          back={dashboardPath(backofficeRouteScopeFromResolvedScope(selectedScope))}
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
  return (
    <section
      ref={panelRef}
      aria-label="Automations"
      className={`min-w-0 ${openedRunScrollMarginClassName}`}
    >
      {workflows.length === 0 ? (
        <>
          <header className={sectionHeaderClassName}>
            <h2 className={sectionTitleClassName}>Automations</h2>
          </header>
          <PanelEmpty>No workflow has run in this scope yet.</PanelEmpty>
        </>
      ) : (
        <div className="backoffice-scroll overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left">
              <tr className="border-b border-[color:var(--bo-border)]">
                <th scope="col" className={`h-9 pr-4 ${sectionTitleClassName}`}>
                  Automations
                </th>
                <th scope="col" className={`h-9 px-3 ${columnLabelClassName}`}>
                  Runs · {WINDOW_LABEL}
                </th>
                <th scope="col" className={`h-9 px-3 text-right ${columnLabelClassName}`}>
                  Success
                </th>
                <th scope="col" className={`h-9 pl-3 text-right ${columnLabelClassName}`}>
                  Last run
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--bo-border)]">
              {visibleWorkflows.map((workflow) => {
                const finished = workflow.completedRuns + workflow.erroredRuns;
                const light = runStatusLights[workflow.latestRun.status];
                return (
                  <tr key={workflow.workflow}>
                    <td className="max-w-[18rem] py-2 pr-4">
                      <Link
                        to={dashboardRunPath(selectedScope, workflow.latestRun)}
                        preventScrollReset
                        className="block truncate font-semibold text-[var(--bo-fg)] hover:underline"
                        title={workflow.workflow}
                      >
                        {workflow.workflow}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-3">
                        <SparkBars
                          values={workflow.startsPerBucket}
                          ariaLabel={`${workflow.workflow} runs over the last ${WINDOW_LABEL}`}
                        />
                        <span className="text-[var(--bo-muted)] tabular-nums">
                          {workflow.startedRuns}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      {finished === 0 ? (
                        <span className="text-[var(--bo-muted-2)]">—</span>
                      ) : (
                        <span
                          className={
                            workflow.erroredRuns > 0
                              ? "text-[var(--bo-failed)]"
                              : "text-[var(--bo-live)]"
                          }
                        >
                          {Math.round((workflow.completedRuns / finished) * 100)}%
                        </span>
                      )}
                    </td>
                    <td className="py-2 pl-3 whitespace-nowrap">
                      <span className="flex items-center justify-end gap-3">
                        <BackofficeStatusLight tone={light.tone} dot={false}>
                          {light.label}
                        </BackofficeStatusLight>
                        <span className="w-16 text-right text-xs text-[var(--bo-muted-2)] tabular-nums">
                          {formatRelativeTime(workflow.latestRun.updatedAt, now)}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {workflows.length > COLLAPSED_WORKFLOW_COUNT ? (
        <div className={panelFooterClassName}>
          <button
            type="button"
            onClick={() => {
              setShowAll((current) => !current);
            }}
            className="font-semibold text-[var(--bo-accent-fg)] hover:underline"
          >
            {showAll ? "Show recent workflows" : `Show all ${workflows.length} workflows`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

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
    <Panel title="Events" back={null} footer={null}>
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
      back={null}
      footer={<PanelFooter to={integrationsScopeBasePath(selectedScope)} page="Integrations" />}
    >
      {dashboard.connections.length === 0 ? (
        <PanelEmpty>No connections yet. Ask your agent to add one.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-[color:var(--bo-border)]">
          {dashboard.connections.map((connection) => (
            <li key={connection.connectionId}>
              <Link
                to={integrationConnectionPath(selectedScope, connection.connectionId)}
                className="group flex items-center gap-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--bo-fg)] group-hover:underline">
                    {integrationConnectionName(connection)}
                  </span>
                  <span className="block truncate text-xs text-[var(--bo-muted-2)]">
                    {describeIntegrationConnectionKind(connection)} ·{" "}
                    {formatRelativeTime(connection.changedAt, now)}
                  </span>
                </span>
                <IntegrationConnectionStateLight state={connection.state} />
              </Link>
            </li>
          ))}
        </ul>
      )}
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
    <Panel title="Scheduled & waiting" back={null} footer={null}>
      <ul className="divide-y divide-[color:var(--bo-border)]">
        {upcoming.map((entry) =>
          entry.kind === "schedule" ? (
            <UpcomingRow
              key={`schedule:${entry.routeId}`}
              to={dashboardSelectionPath(selectedScope, { kind: "route", id: entry.routeId })}
              icon="clock"
              title={entry.name}
              detail="Scheduled route"
              time={formatRelativeTime(entry.at, now)}
            />
          ) : (
            <UpcomingRow
              key={`run:${entry.run.workflowName}:${entry.run.instanceId}`}
              to={dashboardRunPath(selectedScope, entry.run)}
              icon="pause-circle"
              title={entry.workflow}
              detail={
                entry.waitingFor.length > 0
                  ? `Waiting for ${entry.waitingFor.join(", ")}`
                  : "Waiting"
              }
              time={formatRelativeTime(entry.run.updatedAt, now)}
            />
          ),
        )}
      </ul>
    </Panel>
  );
}

function UpcomingRow({
  to,
  icon,
  title,
  detail,
  time,
}: {
  to: string;
  icon: IconName;
  title: string;
  detail: string;
  time: string;
}) {
  return (
    <li>
      <Link to={to} className="group flex items-start gap-3 py-2.5">
        <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-[var(--bo-muted-2)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--bo-fg)] group-hover:underline">
            {title}
          </span>
          <span className="block truncate font-mono text-[11px] text-[var(--bo-muted)]">
            {detail}
          </span>
        </span>
        <span className="shrink-0 text-xs text-[var(--bo-muted-2)] tabular-nums">{time}</span>
      </Link>
    </li>
  );
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
    <Panel title="Agents" back={null} footer={<PanelFooter to={agentsPath} page="Agents" />}>
      <ul className="divide-y divide-[color:var(--bo-border)]">
        {agents.map((agent) => {
          const agentName = formatPiAgentName(agent.agentName);
          const queue = piAgentQueueStatus(agent);
          const turns = agent.turnsPerBucket.reduce((total, count) => total + count, 0);
          return (
            <li key={agent.agentName}>
              <Link
                to={`${agentsPath}/${encodeURIComponent(agent.agentName)}`}
                className="group flex items-center gap-3 py-2.5"
              >
                <Icon name="message-square" className="size-4 shrink-0 text-[var(--bo-muted-2)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--bo-fg)] group-hover:underline">
                    {agentName}
                  </span>
                  <span
                    className={`block truncate text-xs ${agent.answering ? "text-[var(--bo-live)]" : "text-[var(--bo-muted-2)]"}`}
                  >
                    {describePiAgentActivity(agent, now)}
                  </span>
                </span>
                {queue ? (
                  <BackofficeStatusLight tone={queue.tone} dot={false} role="status">
                    {queue.label}
                  </BackofficeStatusLight>
                ) : null}
                {agent.latestAt !== null ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <SparkBars
                      values={agent.turnsPerBucket}
                      ariaLabel={`${agentName} turns over the last ${WINDOW_LABEL}`}
                    />
                    <span className="w-6 text-right text-xs text-[var(--bo-muted)] tabular-nums">
                      {turns}
                    </span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
