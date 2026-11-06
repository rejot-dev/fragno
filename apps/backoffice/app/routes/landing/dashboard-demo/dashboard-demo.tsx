import { ChatActivity, ChatActivityStep } from "@fragno-private/design-system/agents/chat-activity";
import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerToolbar,
  chatComposerInputClassName,
} from "@fragno-private/design-system/agents/chat-composer";
import {
  ChatAssistantMessage,
  ChatUserMessage,
} from "@fragno-private/design-system/agents/chat-message";
import {
  ChatColumn,
  ChatThread,
  ChatViewport,
  ChatViewportFooter,
} from "@fragno-private/design-system/agents/chat-thread";
import { IconButton } from "@fragno-private/design-system/controls/button";
import {
  SelectorMenu,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/controls/selector-menu";
import { DataTable } from "@fragno-private/design-system/data/data-table";
import { ListRow, ListRowIcon, RowList } from "@fragno-private/design-system/data/list-row";
import { Metric } from "@fragno-private/design-system/data/metric";
import { formatRelativeTime } from "@fragno-private/design-system/data/relative-time";
import { StackedBarChart } from "@fragno-private/design-system/data/stacked-bar-chart";
import { PresenceStack } from "@fragno-private/design-system/feedback/presence-stack";
import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/feedback/status-tone";
import { Icon, type IconName } from "@fragno-private/design-system/icon";
import { Panel } from "@fragno-private/design-system/layout/panel";
import {
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/layout/surface-panel";
import type { NavigationItem } from "@fragno-private/design-system/navigation/navigation-item";
import { SidebarNavigationItem } from "@fragno-private/design-system/navigation/navigation-item";
import {
  BackofficeTabHeader,
  backofficePageColumnClassName,
} from "@fragno-private/design-system/navigation/tab-header";
import { TabPinMenu } from "@fragno-private/design-system/navigation/tab-pin-menu";
import { SideDrawerHeader } from "@fragno-private/design-system/overlays/side-drawer";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { AgentMark } from "@/components/backoffice/agent-mark";
import { IntegrationConnectionStateLight } from "@/routes/backoffice/integrations/connection-display";

import type {
  DashboardDemoActivity,
  DashboardDemoAttention,
  DashboardDemoConnection,
  DashboardDemoSignups,
  DashboardDemoState,
} from "./dashboard-demo-state";
import {
  DASHBOARD_DEMOS,
  type DashboardDemoId,
  type DashboardDemoScene,
  promptOf,
} from "./dashboard-demo-story";

// The demo renders at a fixed desktop size and is scaled to its screen, so its layout never
// follows the visitor's viewport: no responsive variants below.

const NAVIGATION: readonly Omit<NavigationItem, "active">[] = [
  { label: "Dashboard", to: "/backoffice/dashboard", icon: "grid" },
  { label: "Integrations", to: "/backoffice/integrations", icon: "link" },
  { label: "Agents", to: "/backoffice/agents", icon: "message-square" },
  { label: "Files", to: "/backoffice/files", icon: "folder" },
  { label: "Computers", to: "/backoffice/computers", icon: "monitor" },
  { label: "Marketplace", to: "/backoffice/marketplace", icon: "shopping-bag" },
];

const SETTINGS: NavigationItem = {
  label: "Settings",
  to: "/backoffice/settings",
  icon: "settings",
  active: false,
};

// The demo has no pages to list; the menu only shows its tab, and lists nothing if opened.
const NO_PAGES = Promise.resolve({ kind: "listed" as const, items: [] });

const PAGE_FILE = "signups.page.js";
const WORKFLOW_FILE = "notify-sales.workflow.js";

type AgentTurn = {
  headline: string;
  steps: readonly { icon: IconName; title: string; detail: string | null; durationMs: number }[];
  reply: ReactNode;
};

// What the agent does and says in each story. Its last step is the one still running.
const AGENT_TURNS: Record<DashboardDemoId, AgentTurn> = {
  connect: {
    headline: "Connecting Google Drive and Slack",
    steps: [
      { icon: "search", title: "Find connectors", detail: null, durationMs: 400 },
      { icon: "link", title: "Connect Google Drive", detail: "OAuth", durationMs: 900 },
      { icon: "link", title: "Connect Slack", detail: "OAuth", durationMs: 800 },
    ],
    reply: (
      <p>
        Google Drive and Slack are connected. I can read your Drive files and post to any channel
        I&rsquo;m invited to.
      </p>
    ),
  },
  page: {
    headline: `Writing ${PAGE_FILE}`,
    steps: [
      { icon: "database", title: "Read signups", detail: null, durationMs: 300 },
      { icon: "file-text", title: "Write page", detail: PAGE_FILE, durationMs: 1800 },
      { icon: "bookmark", title: "Pin to dashboard", detail: null, durationMs: 100 },
    ],
    reply: (
      <p>
        I wrote <code className="font-mono text-[12px]">{PAGE_FILE}</code> and pinned it to your
        dashboard as Signups. It updates as new signups arrive.
      </p>
    ),
  },
  automate: {
    headline: `Writing ${WORKFLOW_FILE}`,
    steps: [
      { icon: "search", title: "Find signup events", detail: null, durationMs: 300 },
      { icon: "file-text", title: "Write workflow", detail: WORKFLOW_FILE, durationMs: 1600 },
      { icon: "corner-down-right", title: "Route Business signups", detail: null, durationMs: 200 },
    ],
    reply: (
      <p>
        I wrote <code className="font-mono text-[12px]">{WORKFLOW_FILE}</code> and routed Business
        signups to it. Each one posts to #sales; the first just ran.
      </p>
    ),
  },
};

/** The Backoffice dashboard, shell and agent drawer included, at one moment of the demo's story. */
export function DashboardDemo({
  state,
  scene,
}: {
  state: DashboardDemoState;
  scene: DashboardDemoScene;
}) {
  // One continuous story: each part starts where the last one left the app. Connecting ends on the
  // Integrations page; the page built next opens as a tab and stays pinned; automating returns to
  // the Overview to show its first run.
  const { demo, resultShown } = scene;
  const onIntegrations = (demo === "connect" && resultShown) || (demo === "page" && !resultShown);
  const signupsOpen = (demo === "page" && resultShown) || (demo === "automate" && !resultShown);
  const signupsPinned = (demo === "page" && resultShown) || demo === "automate";
  const recentActivity =
    scene.demo === "automate" && scene.resultShown
      ? [state.automatedRun, ...state.recentActivity]
      : state.recentActivity;
  return (
    <div className="relative flex h-full bg-[var(--bo-bg)] text-[var(--bo-fg)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar state={state} drawerOpen={scene.drawerOpen} />
        <div className="flex min-h-0 flex-1">
          <Sidebar active={onIntegrations ? "Integrations" : "Dashboard"} />
          <main className="flex min-w-0 flex-1 flex-col">
            {onIntegrations ? (
              <>
                <BackofficeTabHeader
                  items={[
                    {
                      id: "connections",
                      label: "All connections",
                      to: "/backoffice/integrations",
                      active: true,
                    },
                  ]}
                  ariaLabel="Integrations"
                  trailing={null}
                  options={null}
                />
                <div className={`${backofficePageColumnClassName} flex flex-col gap-4 p-6`}>
                  <ConnectionsPanel connections={state.connections} />
                </div>
              </>
            ) : (
              <>
                <BackofficeTabHeader
                  items={[
                    {
                      id: "overview",
                      label: "Overview",
                      to: "/backoffice/dashboard",
                      active: !signupsOpen,
                    },
                    {
                      id: "activity",
                      label: "Activity",
                      to: "/backoffice/dashboard",
                      active: false,
                    },
                    { id: "map", label: "Map", to: "/backoffice/dashboard", active: false },
                    ...(signupsPinned
                      ? [
                          {
                            id: "signups",
                            label: "Signups",
                            to: "/backoffice/dashboard",
                            active: signupsOpen,
                          },
                        ]
                      : []),
                  ]}
                  ariaLabel="Dashboard"
                  trailing={
                    <TabPinMenu
                      title="Pages"
                      label="Add page"
                      loading="Loading pages…"
                      icon="file-text"
                      items={NO_PAGES}
                      activeId={null}
                      pinnedIds={[]}
                      onPinnedChange={() => {}}
                      empty={{ title: "No pages yet", description: null }}
                    />
                  }
                  options={null}
                />
                <div className={`${backofficePageColumnClassName} flex flex-col gap-4 p-6`}>
                  {signupsOpen ? (
                    <SignupsPage signups={state.signups} />
                  ) : (
                    <>
                      <AttentionPanel attention={state.attention} now={state.now} />
                      <RecentActivityPanel entries={recentActivity} now={state.now} />
                    </>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      </div>
      <AgentDrawer scene={scene} />
      <GoogleConsentWindow consent={scene.consent} />
    </div>
  );
}

/**
 * The provider's permission prompt, in the browser window connecting opens over the app: the
 * person confirms on Google's side what Leyway may reach. Drawn plainly, without Google's marks.
 */
function GoogleConsentWindow({ consent }: { consent: DashboardDemoScene["consent"] }) {
  const open = consent !== "closed";
  const approving = consent === "approving";
  // Always mounted, so it fades and settles in, and fades back out, instead of popping.
  return (
    <div
      aria-hidden={!open}
      className={`pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-black/10 transition-opacity duration-300 ease-out ${open ? "opacity-100" : "opacity-0"}`}
    >
      <div
        className={`w-[400px] overflow-hidden rounded-[10px] border border-black/10 bg-white text-[#1f1f1f] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.2)] transition-[translate,scale] duration-300 ease-out ${open ? "translate-y-0 scale-100" : "translate-y-2 scale-[0.98]"}`}
      >
        <div className="flex items-center gap-2 border-b border-black/10 bg-[#f1f3f4] px-3 py-2">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </span>
          <span className="mx-auto flex items-center gap-1.5 rounded-full bg-white px-3 py-0.5 text-[11px] text-black/60">
            <Icon name="lock" className="size-3" />
            accounts.google.com
          </span>
        </div>
        <div className="px-7 pt-6 pb-5">
          <p className="text-xs text-black/60">Sign in with Google</p>
          <p className="mt-3 text-xl leading-7">Leyway wants access to your Google Account</p>
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-black/15 py-1 pr-3 pl-1 text-xs">
            <span className="flex size-5 items-center justify-center rounded-full bg-[#5f6368] text-[10px] font-semibold text-white">
              S
            </span>
            sam@acme.test
          </p>
          <p className="mt-5 text-sm">This will allow Leyway to:</p>
          <p className="mt-2 flex items-start gap-3 border-y border-black/10 py-3 text-sm">
            <Icon name="hard-drive" className="mt-0.5 size-4 shrink-0 text-black/60" />
            See and download all your Google Drive files
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <span className="rounded-full px-4 py-2 text-sm font-medium text-[#0b57d0]">
              Cancel
            </span>
            <span
              className={`rounded-full px-5 py-2 text-sm font-medium text-white transition-[background-color,scale] duration-150 ${approving ? "scale-95 bg-[#0842a0]" : "bg-[#0b57d0]"}`}
            >
              Continue
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TopBar({ state, drawerOpen }: { state: DashboardDemoState; drawerOpen: boolean }) {
  return (
    <header className="flex h-16 shrink-0 items-stretch border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)]">
      {/* The workspace tile takes the primary color; the demo's organization tile is black. */}
      {/* As wide as the collapsed sidebar below it, as the app's top bar is. Clipped, because the
          trigger follows the visitor's viewport and below the sidebar breakpoint shows its label,
          which the demo's fixed desktop has no room for. */}
      <div className="flex w-16 items-stretch overflow-hidden border-r border-[color:var(--bo-border)] [--primary-foreground:#ffffff] [--primary:#0b0b0a]">
        <SelectorMenu>
          <SelectorMenuTrigger
            label="Organization"
            value={state.scopeLabel}
            ariaLabel="Organization"
            layout={{
              kind: "workspace",
              mark: { kind: "letter", letter: state.scopeLabel.charAt(0) },
              color: { kind: "primary" },
              collapsed: true,
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
      <div className="ml-auto flex shrink-0 items-stretch">
        <div className="flex shrink-0 items-center border-l border-[color:var(--bo-border)] px-4">
          <PresenceStack people={state.people} />
        </div>
        <div className="flex shrink-0 items-center border-l border-[color:var(--bo-border)]">
          <SelectorMenu>
            <SelectorMenuTrigger
              label="Appearance"
              value={null}
              ariaLabel="Appearance"
              layout={{ kind: "icon", icon: "sun" }}
            />
          </SelectorMenu>
        </div>
      </div>
      {/* The agent button's face, pressed while the story has the drawer open. */}
      <div
        className={`flex w-16 shrink-0 items-center justify-center border-l border-[color:var(--bo-border)] transition-colors duration-150 ${drawerOpen ? "bg-[color:var(--bo-sidebar-bg)]" : ""}`}
      >
        <AgentMark />
      </div>
    </header>
  );
}

function Sidebar({ active }: { active: string }) {
  return (
    // The app's sidebar, collapsed to its icons so the page has the room. Drawn here rather than
    // through SidebarNavigation, which hides below the sidebar breakpoint and pins itself to the
    // window: the demo is a fixed desktop.
    <aside className="flex w-16 shrink-0 flex-col border-r border-[color:var(--bo-border)] bg-[color:var(--bo-sidebar-bg)]">
      <nav aria-label="Leyway" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-2.5 px-2 py-4">
          {NAVIGATION.map((item) => (
            <SidebarNavigationItem
              key={item.label}
              item={{ ...item, active: item.label === active }}
              collapsed
            />
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-2.5 border-t border-[color:var(--bo-border)] px-2 py-3">
          <SidebarNavigationItem item={SETTINGS} collapsed />
          <IconButton label="Expand sidebar" className="self-center">
            <Icon name="chevrons-right" className="size-4" strokeWidth={1.75} />
          </IconButton>
        </div>
      </nav>
    </aside>
  );
}

/** The agent drawer beside the app, as SideDrawer lays it out, holding the story's conversation. */
function AgentDrawer({ scene }: { scene: DashboardDemoScene }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Keeps the newest message in view as the conversation grows, as the app's thread does.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [scene.demo, scene.sent, scene.work, scene.step, scene.replied]);
  return (
    <aside
      aria-label="Agent conversation"
      className={`flex shrink-0 flex-col overflow-hidden bg-[var(--bo-panel)] transition-[width] duration-300 ease-out [--bo-bg:var(--bo-panel)] ${scene.drawerOpen ? "w-[400px] border-l border-[color:var(--bo-border)]" : "w-0"}`}
    >
      {/* Laid out at the open width, so opening reveals the content instead of reflowing it. */}
      <div className="flex min-h-0 w-[400px] flex-1 flex-col self-end">
        <SideDrawerHeader>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-sm font-semibold">
            Assistant
            <Icon name="chevron-down" className="size-3.5 text-[var(--bo-muted-2)]" />
          </span>
          <IconButton label="Close agent drawer">
            <Icon name="x" className="size-4" />
          </IconButton>
        </SideDrawerHeader>
        <ChatThread>
          <ChatViewport ref={viewportRef}>
            <ChatColumn>
              {/* One conversation across the story: each part's exchange stays where it was, so
                  moving to the next part adds to the thread instead of drawing it again. */}
              {DASHBOARD_DEMOS.slice(
                0,
                DASHBOARD_DEMOS.findIndex((demo) => demo.id === scene.demo) + 1,
              ).map((demo) => (
                <Turn key={demo.id} demo={demo.id} scene={demo.id === scene.demo ? scene : null} />
              ))}
            </ChatColumn>
            <ChatViewportFooter alert={null}>
              <ChatComposer
                disabled={false}
                onSubmit={(event) => {
                  event.preventDefault();
                }}
              >
                <p
                  className={`${chatComposerInputClassName} ${scene.draft ? "" : "text-[var(--bo-muted-2)]"}`}
                >
                  {scene.draft || "Ask the agent…"}
                  {scene.draft ? (
                    <span className="ml-px inline-block h-[1.1em] w-px translate-y-[0.2em] animate-pulse bg-[var(--bo-fg)]" />
                  ) : null}
                </p>
                <ChatComposerToolbar
                  start={null}
                  end={
                    <ChatComposerButton tone="accent" joined={false} type="submit">
                      Send
                    </ChatComposerButton>
                  }
                />
              </ChatComposer>
            </ChatViewportFooter>
          </ChatViewport>
        </ChatThread>
      </div>
    </aside>
  );
}

/**
 * One part's exchange: the request, the agent's work, and its reply. `scene` is the part playing,
 * or null for a finished one.
 */
function Turn({ demo, scene }: { demo: DashboardDemoId; scene: DashboardDemoScene | null }) {
  const sent = scene?.sent ?? true;
  const work = scene?.work ?? "done";
  const replied = scene?.replied ?? true;
  return (
    <>
      {sent ? (
        <ChatUserMessage time={null} attachments={null}>
          <p>{promptOf(demo)}</p>
        </ChatUserMessage>
      ) : null}
      {work === "none" ? null : (
        <div className="mb-4">
          <AgentWork
            turn={AGENT_TURNS[demo]}
            running={work === "running"}
            step={scene?.step ?? 0}
          />
        </div>
      )}
      {replied ? (
        <ChatAssistantMessage author={{ name: "Assistant", time: null }} footer={null}>
          {AGENT_TURNS[demo].reply}
        </ChatAssistantMessage>
      ) : null}
    </>
  );
}

function AgentWork({
  turn,
  running,
  step,
}: {
  turn: AgentTurn;
  running: boolean;
  /** The step under way while running; the steps after it have not started. */
  step: number;
}) {
  // The running card counts up against the real clock, from when the story's work began.
  const [startedAt] = useState(() => new Date());
  const shown = running ? turn.steps.slice(0, step + 1) : turn.steps;
  return (
    <ChatActivity
      status={
        running
          ? { kind: "running", headline: turn.headline, startedAt }
          : {
              kind: "settled",
              outcome: "done",
              durationMs: turn.steps.reduce((total, entry) => total + entry.durationMs, 0),
              note: `${turn.steps.length} tools`,
              failedSteps: 0,
            }
      }
      artifacts={null}
    >
      {shown.map((entry, index) => {
        const stepRunning = running && index === step;
        return (
          <ChatActivityStep
            key={entry.title}
            icon={entry.icon}
            state={stepRunning ? "running" : "done"}
            title={entry.title}
            detail={entry.detail}
            durationMs={stepRunning ? null : entry.durationMs}
            actions={null}
          >
            {null}
          </ChatActivityStep>
        );
      })}
    </ChatActivity>
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

// As on the real Overview: only what is still going gets a status, settled work shows how long it
// took, and work that neither needs a look nor took measurable time shows nothing.
const OUTCOME_TONE: Record<DashboardDemoActivity["outcome"]["kind"], BackofficeStatusTone> = {
  running: "live",
  waiting: "waiting",
  settled: "muted",
  quiet: "muted",
};

function RecentActivityPanel({
  entries,
  now,
}: {
  entries: readonly DashboardDemoActivity[];
  now: number;
}) {
  return (
    <Panel title="Recent activity" leading={null} footer={null}>
      <RowList empty={null}>
        {entries.map((entry) => (
          <ListRow
            key={entry.id}
            to={null}
            leading={<ListRowIcon name={entry.icon} tone={OUTCOME_TONE[entry.outcome.kind]} />}
            title={entry.title}
            detail={entry.trigger}
            trailing={
              <>
                <ActivityOutcome outcome={entry.outcome} />
                <RowTime time={formatRelativeTime(entry.occurredAt, now)} />
              </>
            }
            expansion={null}
          />
        ))}
      </RowList>
    </Panel>
  );
}

function ActivityOutcome({ outcome }: { outcome: DashboardDemoActivity["outcome"] }) {
  switch (outcome.kind) {
    case "running":
      return <BackofficeStatusLight tone="live">Running</BackofficeStatusLight>;
    case "waiting":
      return <BackofficeStatusLight tone="waiting">Waiting</BackofficeStatusLight>;
    case "settled":
      return (
        <span className="shrink-0 text-xs text-[var(--bo-muted-2)] tabular-nums">
          {outcome.duration}
        </span>
      );
    case "quiet":
      return null;
  }
}

const CONNECTION_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Connection", align: "start" },
  { label: "Auth", align: "start" },
  { label: "State", align: "start" },
  { label: "Last change", align: "start" },
];

/** The Integrations page's connections, as its table lists them. */
function ConnectionsPanel({ connections }: { connections: readonly DashboardDemoConnection[] }) {
  return (
    <SurfacePanel caption={`${connections.length} connections`} actions={null}>
      <SurfaceTable columns={CONNECTION_COLUMNS}>
        {connections.map((connection) => (
          <SurfaceTableRow
            key={connection.id}
            columns={CONNECTION_COLUMNS}
            cells={[
              <span key="connection" className="block min-w-0">
                <span className="block truncate font-semibold text-[var(--bo-fg)]">
                  {connection.displayName}
                </span>
                <span className="block truncate font-mono text-[11px] text-[var(--bo-muted)]">
                  {connection.id}
                </span>
              </span>,
              <span key="auth" className="whitespace-nowrap">
                {connection.authLabel}
              </span>,
              <IntegrationConnectionStateLight key="state" state="ready" />,
              <span key="changed" className="text-xs whitespace-nowrap">
                {connection.changed}
              </span>,
            ]}
          />
        ))}
      </SurfaceTable>
    </SurfacePanel>
  );
}

/** The page the agent writes: this week's signups by plan, as a pinned dashboard tab shows it. */
function SignupsPage({ signups }: { signups: DashboardDemoSignups }) {
  const totals = signups.plans.map((plan) =>
    signups.perDay.reduce((total, day) => total + (day.values[plan.id] ?? 0), 0),
  );
  const total = totals.reduce((sum, count) => sum + count, 0);
  return (
    <div className="bo-chat-enter flex flex-col gap-4">
      <Panel title="Signups this week" leading={null} footer={null}>
        <div className="grid grid-cols-4 gap-6 py-4">
          <Metric tone="info" label="Signups" value={String(total)} detail="+18% on last week" />
          {signups.plans.map((plan, index) => (
            <Metric key={plan.id} tone={null} label={plan.label} value={String(totals[index])} />
          ))}
        </div>
        {/* The chart's series take the brand's reds, light to deep, in place of the app's
            status-tinted palette, so the page sits with the landing page around it. */}
        <div className="[--bo-blue-1:#f4a582] [--bo-live:#e0623f] [--bo-waiting:#9c2f1f]">
          <StackedBarChart
            ariaLabel="Signups per day by plan"
            series={signups.plans}
            buckets={signups.perDay.map((day) => ({
              id: day.day,
              label: day.day,
              values: day.values,
            }))}
          />
        </div>
      </Panel>
      <DataTable
        caption="Latest signups"
        columns={[
          { key: "company", label: "Company", align: "start" },
          { key: "plan", label: "Plan", align: "start" },
          { key: "seats", label: "Seats", align: "end" },
          { key: "when", label: "Signed up", align: "end" },
        ]}
        rows={signups.recent}
      />
    </div>
  );
}

function RowTime({ time }: { time: string }) {
  return <span className="text-[var(--bo-muted-2)] tabular-nums">{time}</span>;
}
