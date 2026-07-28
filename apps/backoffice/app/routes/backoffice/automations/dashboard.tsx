import {
  Bot,
  Braces,
  CalendarClock,
  Check,
  CircleDot,
  Cloud,
  GitBranch,
  KeyRound,
  Mail,
  Mic2,
  Send,
  ShieldCheck,
  Upload,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  useLoaderData,
  useOutletContext,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";
import {
  backofficeCapabilities,
  backofficeConnectionCatalog,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";

import type { Route } from "./+types/dashboard";
import {
  DashboardInspector,
  type DashboardInspectorSelection,
  type DashboardSource,
} from "./dashboard-inspector";
import { loadAutomationScriptSource } from "./data.server";
import { formatTimestamp } from "./formatting";
import type { AutomationLayoutContext } from "./layout-context";
import { automationRouteWorkflowName } from "./route-workflow";
import { automationScopeFromRouteParams } from "./scope";
import { toAutomationScriptIdFromAbsolutePath } from "./script-records";
import { AutomationNotice } from "./shared";

const SOURCE_FILTER_PARAM = "source";
const SELECTION_KIND_PARAM = "selection";
const SELECTION_ID_PARAM = "selected";
const WORKFLOW_SCRIPT_ID_PARAM = "workflowScript";
const RECENT_WORKFLOW_LIMIT = 40;
const DASHBOARD_SEARCH_NAVIGATION_OPTIONS = {
  defaultShouldRevalidate: false,
  preventScrollReset: true,
  replace: true,
} as const;

const EMPTY_WORKFLOW_SOURCE = { script: null, scriptError: null };

type DashboardWorkflowInstance = {
  id: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  instanceId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type DashboardRoute = AutomationRouteDefinition;
type DashboardSelectionKind = "source" | "trigger" | "workflow";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_ID_PARAM)?.trim() ?? "";

  return {
    workflowSource: workflowScriptId
      ? await loadAutomationScriptSource({
          request,
          context,
          scope: automationScopeFromRouteParams(params),
          scriptId: workflowScriptId,
        })
      : EMPTY_WORKFLOW_SOURCE,
    runtimeToolCatalog: runtimeToolWorkflowCatalog,
  };
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }

  return (
    currentUrl.searchParams.get(WORKFLOW_SCRIPT_ID_PARAM) !==
    nextUrl.searchParams.get(WORKFLOW_SCRIPT_ID_PARAM)
  );
}

const toErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const normalizedSourceId = (source: string) => source.trim().toLowerCase();

const routeSourceId = (route: DashboardRoute) =>
  route.trigger.kind === "schedule" ? "scheduler" : normalizedSourceId(route.trigger.source);

const fallbackSourceLabel = (source: string) =>
  source
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

const sourceDescriptionById = new Map(
  backofficeConnectionCatalog.map((connection) => [connection.id, connection.description]),
);

const dashboardSources = (routes: readonly DashboardRoute[]): DashboardSource[] => {
  const sources = new Map<string, DashboardSource>();

  for (const capability of backofficeCapabilities) {
    const id = normalizedSourceId(capability.id);
    sources.set(id, {
      id,
      label: capability.label,
      kind: capability.kind,
      description:
        sourceDescriptionById.get(capability.id) ??
        `${capability.label} is available as a ${capability.kind} automation capability.`,
    });
  }

  sources.set("scheduler", {
    id: "scheduler",
    label: "Scheduler",
    kind: "system",
    description: "Starts automation routes at one-time or recurring scheduled occurrences.",
  });

  const triggerCountBySource = new Map<string, number>();
  for (const route of routes) {
    const id = routeSourceId(route);
    triggerCountBySource.set(id, (triggerCountBySource.get(id) ?? 0) + 1);

    if (!sources.has(id)) {
      const label = fallbackSourceLabel(id);
      sources.set(id, {
        id,
        label,
        kind: "system",
        description: `${label} is available as an automation event source.`,
      });
    }
  }

  return [...sources.values()].sort((left, right) => {
    const leftHasTriggers = triggerCountBySource.has(left.id);
    const rightHasTriggers = triggerCountBySource.has(right.id);
    if (leftHasTriggers !== rightHasTriggers) {
      return rightHasTriggers ? 1 : -1;
    }
    return left.label.localeCompare(right.label);
  });
};

const routeWorkflowIdentity = (route: DashboardRoute) => {
  switch (route.action.kind) {
    case "start_workflow":
      return {
        workflowName: route.action.workflowName,
        remoteWorkflowName: route.action.remoteWorkflowName ?? null,
      };
    case "send_workflow_event":
      return { workflowName: route.action.workflowName, remoteWorkflowName: null };
    case "forward_event":
      return null;
  }

  throw new Error("Unsupported automation route action kind.");
};

const latestWorkflowRunForRoute = (
  route: DashboardRoute,
  instances: DashboardWorkflowInstance[],
) => {
  const identity = routeWorkflowIdentity(route);
  if (!identity) {
    return null;
  }

  return (
    instances.find(
      (instance) =>
        instance.workflowName === identity.workflowName &&
        instance.remoteWorkflowName === identity.remoteWorkflowName,
    ) ?? null
  );
};

const routeDestinationLabel = (route: DashboardRoute) => {
  if (route.action.kind !== "forward_event") {
    return automationRouteWorkflowName(route) ?? route.action.workflowName;
  }

  switch (route.action.targetScope.kind) {
    case "system":
      return "System scope";
    case "org":
      return `Organisation · ${route.action.targetScope.orgIdTemplate}`;
    case "project":
      return `Project · ${route.action.targetScope.projectIdTemplate}`;
    case "user":
      return `User · ${route.action.targetScope.userIdTemplate}`;
  }

  throw new Error("Unsupported automation route destination.");
};

const routeActionLabel = (route: DashboardRoute) => {
  switch (route.action.kind) {
    case "start_workflow":
      return "Start workflow";
    case "send_workflow_event":
      return `Send ${route.action.eventType}`;
    case "forward_event":
      return "Forward event";
  }

  throw new Error("Unsupported automation route action kind.");
};

const scheduleLabel = (route: DashboardRoute) => {
  if (route.trigger.kind !== "schedule") {
    return null;
  }
  if (route.trigger.cadence.kind === "once") {
    return `Once · ${formatTimestamp(route.trigger.cadence.at)}`;
  }
  return `Cron · ${route.trigger.cadence.expression} · ${route.trigger.cadence.timeZone}`;
};

const statusTone = (status: string) => {
  if (["complete", "completed", "success", "succeeded"].includes(status)) {
    return "success" as const;
  }
  if (["errored", "error", "failed", "terminated"].includes(status)) {
    return "error" as const;
  }
  if (["active", "running"].includes(status)) {
    return "active" as const;
  }
  return "waiting" as const;
};

function SourceIcon({ source }: { source: string }) {
  const iconClassName = "h-3.5 w-3.5";
  switch (source) {
    case "telegram":
      return <Send className={iconClassName} strokeWidth={1.8} />;
    case "otp":
    case "auth":
      return <KeyRound className={iconClassName} strokeWidth={1.8} />;
    case "github":
      return <GitBranch className={iconClassName} strokeWidth={1.8} />;
    case "upload":
      return <Upload className={iconClassName} strokeWidth={1.8} />;
    case "pi":
      return <Bot className={iconClassName} strokeWidth={1.8} />;
    case "scheduler":
      return <CalendarClock className={iconClassName} strokeWidth={1.8} />;
    case "api":
      return <Braces className={iconClassName} strokeWidth={1.8} />;
    case "resend":
      return <Mail className={iconClassName} strokeWidth={1.8} />;
    case "reson8":
      return <Mic2 className={iconClassName} strokeWidth={1.8} />;
    case "sandbox":
      return <Cloud className={iconClassName} strokeWidth={1.8} />;
    case "automations":
      return <Zap className={iconClassName} strokeWidth={1.8} />;
    case "mcp":
      return <CircleDot className={iconClassName} strokeWidth={1.8} />;
    default:
      return <ShieldCheck className={iconClassName} strokeWidth={1.8} />;
  }
}

function LaneHeader({
  dotClassName,
  icon,
  title,
  description,
  action,
}: {
  dotClassName: string;
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${dotClassName}`} aria-hidden="true" />
          <span className="text-[var(--bo-muted)]">{icon}</span>
          <h2 className="text-xs font-semibold text-[var(--bo-fg)]">{title}</h2>
        </div>
        {action}
      </div>
      <p className="mt-1 pl-6 text-[9px] text-[var(--bo-muted-2)]">{description}</p>
    </div>
  );
}

function SourceCard({
  source,
  triggerCount,
  enabledTriggerCount,
  selected,
  onSelect,
}: {
  source: DashboardSource;
  triggerCount: number;
  enabledTriggerCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex min-h-14 w-full min-w-0 items-center gap-2.5 rounded-md border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${
        selected ? "ring-2 ring-lime-600/35" : ""
      }`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-lime-500/10 text-lime-700 dark:text-lime-300">
        <SourceIcon source={source.id} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-[var(--bo-fg)]">
          {source.label}
        </span>
        <span className="mt-0.5 block truncate text-[8px] tracking-[0.12em] text-[var(--bo-muted-2)] uppercase">
          {source.kind} capability
        </span>
      </span>
      <span className="shrink-0 text-right text-[8px] leading-4 text-[var(--bo-muted-2)] tabular-nums">
        {triggerCount === 0 ? (
          "No triggers"
        ) : (
          <>
            {triggerCount} trigger{triggerCount === 1 ? "" : "s"}
            <br />
            {enabledTriggerCount} enabled
          </>
        )}
      </span>
    </button>
  );
}

function TriggerCard({
  route,
  selected,
  onSelect,
}: {
  route: DashboardRoute;
  selected: boolean;
  onSelect: () => void;
}) {
  const triggerLabel =
    route.trigger.kind === "schedule"
      ? route.trigger.cadence.kind === "cron"
        ? "Cron trigger"
        : "One-time trigger"
      : "Event trigger";
  const triggerDetail =
    route.trigger.kind === "schedule"
      ? scheduleLabel(route)
      : `${route.trigger.source}.${route.trigger.eventType}`;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`group min-h-16 w-full min-w-0 rounded-md border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${
        selected ? "ring-2 ring-orange-600/30" : ""
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-orange-500/10 text-orange-700 dark:text-orange-300">
          {route.trigger.kind === "schedule" ? (
            <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.8} />
          ) : (
            <Zap className="h-3.5 w-3.5" strokeWidth={1.8} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[11px] font-semibold text-[var(--bo-fg)]">{route.name}</p>
            <span className="shrink-0 text-[7px] font-semibold tracking-[0.12em] text-[var(--bo-muted-2)] uppercase">
              P{route.priority}
            </span>
          </div>
          <p className="mt-0.5 text-[8px] font-semibold tracking-[0.13em] text-orange-700 uppercase dark:text-orange-300">
            {triggerLabel}
            {route.enabled ? "" : " · Disabled"}
          </p>
          <p className="mt-1 truncate font-mono text-[9px] text-[var(--bo-muted-2)]">
            {triggerDetail}
          </p>
        </div>
      </div>
    </button>
  );
}

function WorkflowStatus({ status }: { status: string }) {
  const tone = statusTone(status);
  const className =
    tone === "success"
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
      : tone === "error"
        ? "bg-red-500/12 text-red-700 dark:text-red-300"
        : tone === "active"
          ? "bg-sky-500/12 text-sky-700 dark:text-sky-300"
          : "bg-amber-500/12 text-amber-700 dark:text-amber-300";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[7px] font-semibold tracking-[0.1em] uppercase ${className}`}
    >
      {tone === "success" ? (
        <Check className="h-2 w-2" />
      ) : tone === "error" ? (
        <X className="h-2 w-2" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {status}
    </span>
  );
}

function WorkflowCard({
  route,
  instance,
  selected,
  onSelect,
}: {
  route: DashboardRoute;
  instance: DashboardWorkflowInstance | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const destination = routeDestinationLabel(route);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`group min-h-16 w-full min-w-0 rounded-md border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${
        selected ? "ring-2 ring-rose-900/25 dark:ring-rose-300/25" : ""
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-rose-950/8 text-rose-950 dark:bg-rose-300/10 dark:text-rose-200">
          {route.action.kind === "forward_event" ? (
            <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />
          ) : (
            <Workflow className="h-3.5 w-3.5" strokeWidth={1.8} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[11px] font-semibold text-[var(--bo-fg)]">
                {destination}
              </p>
              <p className="mt-0.5 truncate text-[9px] text-[var(--bo-muted-2)]">
                {routeActionLabel(route)}
              </p>
            </div>
            {instance ? <WorkflowStatus status={instance.status} /> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[9px] text-[var(--bo-muted-2)] tabular-nums">
            {instance
              ? `${instance.instanceId} · ${formatTimestamp(instance.updatedAt)}`
              : route.action.kind === "forward_event"
                ? "Continues in the target scope"
                : "No recent instance"}
          </p>
        </div>
      </div>
    </button>
  );
}

const isSelectionKind = (value: string | null): value is DashboardSelectionKind =>
  value === "source" || value === "trigger" || value === "workflow";

export default function BackofficeAutomationDashboard() {
  const { collections } = useOutletContext<AutomationLayoutContext>();
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const routesQuery = useLiveQuery(
    (query) =>
      query
        .from({ route: collections.routes })
        .leftJoin({ schedule: collections.routeScheduleStates }, ({ route, schedule }) =>
          eq(route.id, schedule.id),
        )
        .orderBy(({ route }) => route.priority, "asc")
        .orderBy(({ route }) => route.id, "asc")
        .select(({ route, schedule }) => ({
          id: route.id,
          name: route.name,
          enabled: route.enabled,
          priority: route.priority,
          trigger: route.trigger,
          action: route.action,
          description: route.description,
          nextOccurrenceAt: schedule?.nextOccurrenceAt,
        })),
    [collections.routeScheduleStates, collections.routes],
  );
  const workflowsQuery = useLiveQuery(
    (query) =>
      query
        .from({ instance: collections.workflowInstances })
        .orderBy(({ instance }) => instance.updatedAt, "desc")
        .orderBy(({ instance }) => instance.id, "desc")
        .limit(RECENT_WORKFLOW_LIMIT)
        .select(({ instance }) => ({
          id: instance.id,
          workflowName: instance.workflowName,
          remoteWorkflowName: instance.remoteWorkflowName,
          instanceId: instance.instanceId,
          status: instance.status,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt,
          completedAt: instance.completedAt,
        })),
    [collections.workflowInstances],
  );

  const routes: DashboardRoute[] = (routesQuery.data ?? []).map((route) => ({
    ...route,
    nextOccurrenceAt: route.nextOccurrenceAt?.toISOString() ?? null,
  }));
  const workflowInstances = (workflowsQuery.data ?? []) as DashboardWorkflowInstance[];
  const sources = dashboardSources(routes);
  const requestedSourceId = normalizedSourceId(searchParams.get(SOURCE_FILTER_PARAM) ?? "");
  const activeSource = sources.find((source) => source.id === requestedSourceId) ?? null;
  const visibleRoutes = activeSource
    ? routes.filter((route) => routeSourceId(route) === activeSource.id)
    : routes;
  const selectionKind = isSelectionKind(searchParams.get(SELECTION_KIND_PARAM))
    ? searchParams.get(SELECTION_KIND_PARAM)
    : null;
  const selectionId = searchParams.get(SELECTION_ID_PARAM)?.trim() ?? "";
  const selectedRoute = routes.find((route) => route.id === selectionId) ?? null;
  const selectedSource = sources.find((source) => source.id === selectionId) ?? null;
  const inspectorSelection: DashboardInspectorSelection =
    selectionKind === "source" && selectedSource
      ? {
          kind: "source",
          source: selectedSource,
          routes: routes.filter((route) => routeSourceId(route) === selectedSource.id),
        }
      : selectionKind === "trigger" && selectedRoute
        ? { kind: "trigger", route: selectedRoute }
        : selectionKind === "workflow" && selectedRoute
          ? { kind: "workflow", route: selectedRoute }
          : null;
  const errors = [
    routesQuery.isError
      ? toErrorMessage(
          collections.routes.utils.getLastError() ??
            collections.routeScheduleStates.utils.getLastError(),
          "Route synchronization failed.",
        )
      : null,
    workflowsQuery.isError
      ? toErrorMessage(
          collections.workflowInstances.utils.getLastError(),
          "Workflow synchronization failed.",
        )
      : null,
  ].filter((message): message is string => Boolean(message));

  const updateSelection = ({
    kind,
    id,
    workflowScriptId,
  }: {
    kind: DashboardSelectionKind;
    id: string;
    workflowScriptId?: string;
  }) => {
    setSearchParams((currentSearchParams) => {
      const nextSearchParams = new URLSearchParams(currentSearchParams);
      nextSearchParams.set(SELECTION_KIND_PARAM, kind);
      nextSearchParams.set(SELECTION_ID_PARAM, id);
      if (workflowScriptId) {
        nextSearchParams.set(WORKFLOW_SCRIPT_ID_PARAM, workflowScriptId);
      } else {
        nextSearchParams.delete(WORKFLOW_SCRIPT_ID_PARAM);
      }
      return nextSearchParams;
    }, DASHBOARD_SEARCH_NAVIGATION_OPTIONS);
  };

  return (
    <section className="w-full max-w-none space-y-3 antialiased">
      {errors.length > 0 ? (
        <AutomationNotice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">
            Some dashboard data could not be synchronized
          </p>
          <p className="mt-2 text-sm">{errors.join(" ")}</p>
        </AutomationNotice>
      ) : null}

      <div className="grid min-w-0 gap-3 xl:grid-cols-[28rem_minmax(0,1fr)]">
        <DashboardInspector
          selection={inspectorSelection}
          workflowSource={loaderData.workflowSource}
          runtimeToolCatalog={loaderData.runtimeToolCatalog}
          onClear={() => {
            setSearchParams((currentSearchParams) => {
              const nextSearchParams = new URLSearchParams(currentSearchParams);
              nextSearchParams.delete(SOURCE_FILTER_PARAM);
              nextSearchParams.delete(SELECTION_KIND_PARAM);
              nextSearchParams.delete(SELECTION_ID_PARAM);
              nextSearchParams.delete(WORKFLOW_SCRIPT_ID_PARAM);
              return nextSearchParams;
            }, DASHBOARD_SEARCH_NAVIGATION_OPTIONS);
          }}
        />

        <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
          <div className="backoffice-scroll overflow-x-auto">
            <div className="w-full min-w-[1100px]">
              <div className="grid grid-cols-[18rem_minmax(20rem,1fr)_minmax(22rem,1.1fr)] gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3">
                <LaneHeader
                  dotClassName="bg-[#94a86d]"
                  icon={<CircleDot className="h-3 w-3" strokeWidth={1.8} />}
                  title="Sources"
                  description={
                    activeSource
                      ? `Showing routes from ${activeSource.label}`
                      : "All capabilities are always visible"
                  }
                  action={
                    activeSource ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchParams((currentSearchParams) => {
                            const nextSearchParams = new URLSearchParams(currentSearchParams);
                            nextSearchParams.delete(SOURCE_FILTER_PARAM);
                            if (
                              nextSearchParams.get(SELECTION_KIND_PARAM) === "source" &&
                              nextSearchParams.get(SELECTION_ID_PARAM) === activeSource.id
                            ) {
                              nextSearchParams.delete(SELECTION_KIND_PARAM);
                              nextSearchParams.delete(SELECTION_ID_PARAM);
                            }
                            return nextSearchParams;
                          }, DASHBOARD_SEARCH_NAVIGATION_OPTIONS);
                        }}
                        className="min-h-10 px-2 text-[8px] font-semibold tracking-[0.12em] text-[var(--bo-muted)] uppercase transition-[color,transform] hover:text-[var(--bo-fg)] active:scale-[0.96]"
                      >
                        Clear
                      </button>
                    ) : null
                  }
                />
                <LaneHeader
                  dotClassName="bg-[#c47c31]"
                  icon={<Zap className="h-3 w-3" strokeWidth={1.8} />}
                  title="Triggers"
                  description="Events, schedules, matchers, and priority"
                />
                <LaneHeader
                  dotClassName="bg-[#581022]"
                  icon={<Workflow className="h-3 w-3" strokeWidth={1.8} />}
                  title="Workflows"
                  description="Destinations and their latest run state"
                />
              </div>

              <div className="grid grid-cols-[18rem_minmax(20rem,1fr)_minmax(22rem,1.1fr)] items-stretch gap-3 px-3">
                <div className="space-y-1.5 py-3">
                  {sources.map((source) => {
                    const sourceRoutes = routes.filter(
                      (route) => routeSourceId(route) === source.id,
                    );
                    return (
                      <SourceCard
                        key={source.id}
                        source={source}
                        triggerCount={sourceRoutes.length}
                        enabledTriggerCount={sourceRoutes.filter((route) => route.enabled).length}
                        selected={activeSource?.id === source.id}
                        onSelect={() => {
                          const isClearing = activeSource?.id === source.id;
                          setSearchParams((currentSearchParams) => {
                            const nextSearchParams = new URLSearchParams(currentSearchParams);
                            if (isClearing) {
                              nextSearchParams.delete(SOURCE_FILTER_PARAM);
                              nextSearchParams.delete(SELECTION_KIND_PARAM);
                              nextSearchParams.delete(SELECTION_ID_PARAM);
                            } else {
                              nextSearchParams.set(SOURCE_FILTER_PARAM, source.id);
                              nextSearchParams.set(SELECTION_KIND_PARAM, "source");
                              nextSearchParams.set(SELECTION_ID_PARAM, source.id);
                            }
                            nextSearchParams.delete(WORKFLOW_SCRIPT_ID_PARAM);
                            return nextSearchParams;
                          }, DASHBOARD_SEARCH_NAVIGATION_OPTIONS);
                        }}
                      />
                    );
                  })}
                </div>

                <div className="col-span-2 divide-y divide-[color:var(--bo-border)]">
                  {routesQuery.isLoading && routes.length === 0 ? (
                    <div className="px-3 py-5 text-xs text-[var(--bo-muted)]">
                      Synchronizing automation routes…
                    </div>
                  ) : visibleRoutes.length === 0 ? (
                    <div className="px-3 py-5">
                      <p className="text-xs font-semibold text-[var(--bo-fg)]">
                        No triggers configured
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--bo-muted)]">
                        {activeSource
                          ? `${activeSource.label} is available, but no route currently uses it.`
                          : "No automation routes are defined for this scope."}
                      </p>
                    </div>
                  ) : (
                    visibleRoutes.map((route) => {
                      const latestInstance = latestWorkflowRunForRoute(route, workflowInstances);
                      return (
                        <article
                          key={route.id}
                          className={`grid grid-cols-[minmax(20rem,1fr)_minmax(22rem,1.1fr)] gap-3 py-2.5 ${
                            route.enabled ? "" : "bg-[var(--bo-panel)]/45"
                          }`}
                        >
                          <TriggerCard
                            route={route}
                            selected={selectionKind === "trigger" && selectionId === route.id}
                            onSelect={() => {
                              updateSelection({ kind: "trigger", id: route.id });
                            }}
                          />
                          <WorkflowCard
                            route={route}
                            instance={latestInstance}
                            selected={selectionKind === "workflow" && selectionId === route.id}
                            onSelect={() => {
                              updateSelection({
                                kind: "workflow",
                                id: route.id,
                                workflowScriptId:
                                  route.action.kind === "start_workflow"
                                    ? toAutomationScriptIdFromAbsolutePath(
                                        route.action.workflowScriptPath,
                                      )
                                    : undefined,
                              });
                            }}
                          />
                        </article>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
