import { RunStatusLight } from "@fragno-private/backoffice-ui/run-status-light";
import { Icon } from "@fragno-private/design-system/icon";
import { ListRow, ListRowIcon, RowList } from "@fragno-private/design-system/list-row";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { SidebarNavigationItem } from "@fragno-private/design-system/navigation-item";
import { OrchestrationLayeredGraph } from "@fragno-private/design-system/orchestration-layered-graph";
import {
  Panel,
  PanelTable,
  PanelTableRow,
  panelRowTitleClassName,
} from "@fragno-private/design-system/panel";
import { formatRelativeTime } from "@fragno-private/design-system/relative-time";
import { SelectorMenu, SelectorMenuTrigger } from "@fragno-private/design-system/selector-menu";
import { SparkBars } from "@fragno-private/design-system/spark-bars";
import { StackedBarChart } from "@fragno-private/design-system/stacked-bar-chart";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";

import { IntegrationConnectionStateLight } from "@/routes/backoffice/integrations/connection-display";

import type { DashboardDemoAttention, DashboardDemoState } from "./dashboard-demo-state";

// The demo renders at a fixed desktop size and is scaled to its screen, so its layout never
// follows the visitor's viewport: no responsive variants below.

const NAVIGATION: NavigationItem[] = [
  { label: "Dashboard", to: "/backoffice/dashboard", icon: "grid", active: true },
  { label: "Integrations", to: "/backoffice/integrations", icon: "link", active: false },
  { label: "Agents", to: "/backoffice/agents", icon: "message-square", active: false },
  { label: "Files", to: "/backoffice/files", icon: "folder", active: false },
  { label: "Computers", to: "/backoffice/computers", icon: "monitor", active: false },
  { label: "Marketplace", to: "/backoffice/marketplace", icon: "shopping-bag", active: false },
];

const WINDOW_LABEL = "24 hours";

const workflowColumns = [
  { label: `Runs · ${WINDOW_LABEL}`, align: "start" },
  { label: "Success", align: "end" },
  { label: "Last run", align: "end" },
] as const;

/** The Backoffice dashboard, shell included, drawn from a demo state instead of a live scope. */
export function DashboardDemo({ state }: { state: DashboardDemoState }) {
  return (
    <div className="flex h-full flex-col bg-[var(--bo-bg)] text-[var(--bo-fg)]">
      <header className="flex h-16 shrink-0 items-stretch border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)]">
        {/* The workspace tile takes the primary color; the demo's organization tile is black. */}
        <div className="flex w-72 items-stretch border-r border-[color:var(--bo-border)] [--primary-foreground:#ffffff] [--primary:#0b0b0a]">
          <SelectorMenu>
            <SelectorMenuTrigger
              label="Organization"
              value={state.graph.scopeLabel}
              ariaLabel="Organization"
              layout={{
                kind: "workspace",
                mark: { kind: "letter", letter: state.graph.scopeLabel.charAt(0) },
                color: { kind: "primary" },
                collapsed: false,
              }}
            />
          </SelectorMenu>
        </div>
        <div className="flex w-72 items-stretch border-r border-[color:var(--bo-border)]">
          <SelectorMenu>
            <SelectorMenuTrigger
              label="Project"
              value={null}
              ariaLabel="Project"
              layout={{ kind: "fill" }}
            />
          </SelectorMenu>
        </div>
        <div className="ml-auto flex items-stretch border-l border-[color:var(--bo-border)]">
          <SelectorMenu>
            <SelectorMenuTrigger
              label="Account"
              value="Sam"
              ariaLabel="Account"
              layout={{ kind: "hug", initials: "S" }}
            />
          </SelectorMenu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-[color:var(--bo-border)] bg-[color:var(--bo-sidebar-bg)]">
          <nav aria-label="Backoffice" className="px-gutter flex flex-col gap-2.5 py-4">
            {NAVIGATION.map((item) => (
              <SidebarNavigationItem key={item.label} item={item} collapsed={false} />
            ))}
          </nav>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <BackofficeTabHeader
            items={[
              { id: "overview", label: "Overview", to: "/backoffice/dashboard", active: true },
              { id: "events", label: "Events", to: "/backoffice/dashboard", active: false },
            ]}
            ariaLabel="Dashboard"
            trailing={null}
            options={null}
          />
          <div className="flex flex-col gap-6 p-6">
            <AttentionPanel attention={state.attention} now={state.now} />

            <Panel title="Orchestration" leading={null} footer={null}>
              <div className="flex min-h-0 flex-col pt-3">
                <OrchestrationLayeredGraph
                  graph={state.graph}
                  selected={null}
                  onSelect={() => {}}
                  pulses={[]}
                />
              </div>
            </Panel>

            <div className="grid grid-cols-[minmax(0,1fr)_20rem] items-start gap-x-10">
              <div className="flex min-w-0 flex-col gap-8">
                <WorkflowsPanel state={state} />
                <EventsPanel state={state} />
              </div>
              <div className="flex min-w-0 flex-col gap-8">
                <ConnectionsPanel state={state} />
                <AgentsPanel state={state} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function AttentionPanel({
  attention,
  now,
}: {
  attention: readonly DashboardDemoAttention[];
  now: number;
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
          <ListRow
            key={item.workflow}
            to={null}
            leading={<ListRowIcon name="edit-3" tone="info" />}
            title={item.workflow}
            detail="Waiting for your input"
            trailing={<RowTime time={formatRelativeTime(item.updatedAt, now)} />}
            expansion={null}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function WorkflowsPanel({ state }: { state: DashboardDemoState }) {
  return (
    <PanelTable
      title="Automations"
      columns={workflowColumns}
      empty="No workflow has run in this scope yet."
      footer={null}
    >
      {state.workflows.map((workflow) => {
        const started = workflow.startsPerHour.reduce((total, count) => total + count, 0);
        return (
          <PanelTableRow
            key={workflow.name}
            columns={workflowColumns}
            title={<span className={panelRowTitleClassName}>{workflow.name}</span>}
            cells={[
              <>
                <SparkBars
                  values={workflow.startsPerHour}
                  ariaLabel={`${workflow.name} runs over the last ${WINDOW_LABEL}`}
                />
                <span className="text-[var(--bo-muted)] tabular-nums">{started}</span>
              </>,
              <span className="text-[var(--bo-live)] tabular-nums">{workflow.successRate}%</span>,
              <>
                <RunStatusLight status={workflow.latestStatus} />
                <span className="w-16 text-right text-xs text-[var(--bo-muted-2)] tabular-nums">
                  {formatRelativeTime(workflow.latestAt, state.now)}
                </span>
              </>,
            ]}
          />
        );
      })}
    </PanelTable>
  );
}

function EventsPanel({ state }: { state: DashboardDemoState }) {
  const hours = state.eventsPerHour.length;
  return (
    <Panel title="Events" leading={null} footer={null}>
      <div className="py-4">
        <StackedBarChart
          series={state.eventSources.map((source) => ({ id: source, label: source }))}
          buckets={state.eventsPerHour.map((values, index) => ({
            id: String(index),
            label: `${hours - index}h ago`,
            values,
          }))}
          ariaLabel={`Events per source over the last ${WINDOW_LABEL}`}
        />
      </div>
    </Panel>
  );
}

function ConnectionsPanel({ state }: { state: DashboardDemoState }) {
  return (
    <Panel title="Connections" leading={null} footer={null}>
      <RowList empty="No connections yet. Ask your agent to add one.">
        {state.connections.map((connection) => (
          <ListRow
            key={connection.id}
            to={null}
            leading={null}
            title={connection.displayName}
            detail={`${connection.kindLabel} · ${formatRelativeTime(connection.changedAt, state.now)}`}
            trailing={<IntegrationConnectionStateLight state={connection.state} />}
            expansion={null}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function AgentsPanel({ state }: { state: DashboardDemoState }) {
  return (
    <Panel title="Agents" leading={null} footer={null}>
      <RowList empty={null}>
        {state.agents.map((agent) => (
          <ListRow
            key={agent.name}
            to={null}
            leading={<ListRowIcon name="message-square" tone={null} />}
            title={agent.name}
            detail={
              <span className={agent.answering ? "text-[var(--bo-live)]" : undefined}>
                {agent.activity}
              </span>
            }
            trailing={
              <span className="flex shrink-0 items-center gap-2">
                <SparkBars
                  values={agent.turnsPerHour}
                  ariaLabel={`${agent.name} turns over the last ${WINDOW_LABEL}`}
                />
                <span className="w-6 text-right text-xs text-[var(--bo-muted)] tabular-nums">
                  {agent.turnsPerHour.reduce((total, count) => total + count, 0)}
                </span>
              </span>
            }
            expansion={null}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function RowTime({ time }: { time: string }) {
  return <span className="text-[var(--bo-muted-2)] tabular-nums">{time}</span>;
}
