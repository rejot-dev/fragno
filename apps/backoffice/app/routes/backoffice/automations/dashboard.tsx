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
import { Fragment, type ReactNode } from "react";
import {
  useLoaderData,
  useOutletContext,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { z } from "zod";

import { eq, or, useLiveQuery } from "@tanstack/react-db";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";
import {
  listAutomationEventDescriptors,
  listCapabilityEventSources,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";

import { filesScopeBasePath } from "../files/scope";
import type { Route } from "./+types/dashboard";
import {
  DashboardInspector,
  type DashboardEventDefinition,
  type DashboardInspectorSelection,
  type DashboardSource,
} from "./dashboard-inspector";
import { loadAutomationScriptSource } from "./data.server";
import { formatTimestamp } from "./formatting";
import type { AutomationLayoutContext } from "./layout-context";
import {
  automationRouteMatchesWorkflowInstance,
  automationRouteWorkflowName,
} from "./route-workflow";
import { automationScopeTabPath } from "./scope";
import { requireAutomationRouteExecution } from "./scope.server";
import { toAutomationScriptIdFromAbsolutePath } from "./script-records";
import { AutomationNotice } from "./shared";

const SOURCE_FILTER_PARAM = "source";
const SELECTION_KIND_PARAM = "selection";
const SELECTION_ID_PARAM = "selected";
const WORKFLOW_SCRIPT_ID_PARAM = "workflowScript";
const ACTIVE_WORKFLOW_LIMIT = 40;
const DASHBOARD_SEARCH_NAVIGATION_OPTIONS = {
  defaultShouldRevalidate: false,
  preventScrollReset: true,
  replace: true,
} as const;

const EMPTY_WORKFLOW_SOURCE = { script: null, scriptError: null };
const codemodeWorkflowScriptReferenceSchema = z.object({
  program: z.object({ filename: z.string() }),
});

type DashboardWorkflowInstance = {
  id: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  instanceId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  workflowScriptPath: string | null;
};

type DashboardRoute = AutomationRouteDefinition;
type DashboardSelectionKind = "source" | "event" | "trigger" | "action";
type AutomationSwimlaneView = "workflows" | "events";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_ID_PARAM)?.trim() ?? "";

  return {
    workflowSource: workflowScriptId
      ? await loadAutomationScriptSource({
          context,
          execution: await requireAutomationRouteExecution(request, context, params),
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

const normalizedSourceId = (source: string) => source.trim().toLowerCase();

const routeSourceId = (route: DashboardRoute) =>
  route.trigger.kind === "schedule" ? "scheduler" : normalizedSourceId(route.trigger.source);

const fallbackSourceLabel = (source: string) =>
  source
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

function dashboardSources({
  routes,
  eventSources,
  eventDefinitions,
  includeUnroutedSources,
}: {
  routes: readonly DashboardRoute[];
  eventSources: readonly DashboardSource[];
  eventDefinitions: readonly DashboardEventDefinitionWithSource[];
  includeUnroutedSources: boolean;
}): DashboardSource[] {
  const sourceCatalog = new Map<string, DashboardSource>();

  for (const eventSource of listCapabilityEventSources()) {
    const id = normalizedSourceId(eventSource.source);
    sourceCatalog.set(id, {
      id,
      label: eventSource.label,
      description: eventSource.description,
    });
  }

  for (const eventSource of eventSources) {
    const id = normalizedSourceId(eventSource.id);
    sourceCatalog.set(id, { ...eventSource, id });
  }

  for (const eventDefinition of eventDefinitions) {
    const id = normalizedSourceId(eventDefinition.source);
    if (!sourceCatalog.has(id)) {
      const label = fallbackSourceLabel(id);
      sourceCatalog.set(id, {
        id,
        label,
        description: `${label} has registered automation events.`,
      });
    }
  }

  const sources = includeUnroutedSources
    ? new Map<string, DashboardSource>(sourceCatalog)
    : new Map<string, DashboardSource>();
  const triggerCountBySource = new Map<string, number>();
  for (const route of routes) {
    const id = routeSourceId(route);
    triggerCountBySource.set(id, (triggerCountBySource.get(id) ?? 0) + 1);

    if (!sources.has(id)) {
      const catalogSource = sourceCatalog.get(id);
      const label = catalogSource?.label ?? fallbackSourceLabel(id);
      sources.set(
        id,
        catalogSource ?? {
          id,
          label,
          description: `${label} produces events used by configured automation routes.`,
        },
      );
    }
  }

  return [...sources.values()].sort((left, right) => {
    const triggerCountDifference =
      (triggerCountBySource.get(right.id) ?? 0) - (triggerCountBySource.get(left.id) ?? 0);
    return triggerCountDifference || left.label.localeCompare(right.label);
  });
}

type DashboardEventDefinitionWithSource = DashboardEventDefinition & {
  source: string;
};

type DashboardGridRow = {
  sourceId: string;
  source: DashboardSource | null;
  route: DashboardRoute | null;
  dividerAfterSource: boolean;
};

type EventSwimlaneRow = {
  sourceId: string;
  eventId: string | null;
  source: DashboardSource | null;
  eventDefinition: DashboardEventDefinitionWithSource | null;
  route: DashboardRoute | null;
  dividerAfterSource: boolean;
};

const dashboardRoutesBySourceId = (routes: readonly DashboardRoute[]) => {
  const routesBySourceId = new Map<string, DashboardRoute[]>();
  for (const route of routes) {
    const sourceId = routeSourceId(route);
    const sourceRoutes = routesBySourceId.get(sourceId) ?? [];
    sourceRoutes.push(route);
    routesBySourceId.set(sourceId, sourceRoutes);
  }
  return routesBySourceId;
};

const dashboardGridRows = (
  sources: readonly DashboardSource[],
  routes: readonly DashboardRoute[],
): DashboardGridRow[] => {
  const routesBySourceId = dashboardRoutesBySourceId(routes);

  return sources.flatMap<DashboardGridRow>((source, sourceIndex) => {
    const sourceRoutes = routesBySourceId.get(source.id) ?? [];
    const hasFollowingSource = sourceIndex < sources.length - 1;
    if (sourceRoutes.length === 0) {
      return [{ sourceId: source.id, source, route: null, dividerAfterSource: hasFollowingSource }];
    }

    return sourceRoutes.map((route, routeIndex) => ({
      sourceId: source.id,
      source: routeIndex === 0 ? source : null,
      route,
      dividerAfterSource: hasFollowingSource && routeIndex === sourceRoutes.length - 1,
    }));
  });
};

const eventSwimlaneRows = (
  sources: readonly DashboardSource[],
  eventDefinitions: readonly DashboardEventDefinitionWithSource[],
  routes: readonly DashboardRoute[],
): EventSwimlaneRow[] => {
  return sources.flatMap<EventSwimlaneRow>((source, sourceIndex) => {
    const events = new Map<string, DashboardEventDefinitionWithSource>();
    for (const eventDefinition of eventDefinitions) {
      if (normalizedSourceId(eventDefinition.source) === source.id) {
        events.set(eventDefinition.eventType, eventDefinition);
      }
    }

    for (const route of routes) {
      if (routeSourceId(route) !== source.id) {
        continue;
      }
      const eventType =
        route.trigger.kind === "schedule" ? `schedule:${route.id}` : route.trigger.eventType;
      if (!events.has(eventType)) {
        events.set(eventType, {
          source: source.id,
          eventType,
          label:
            route.trigger.kind === "schedule"
              ? (scheduleLabel(route) ?? route.name)
              : route.trigger.eventType,
          payloadSchema: null,
        });
      }
    }

    const sourceEvents = [...events.values()].sort((left, right) => {
      const routeCount = (eventType: string) =>
        routes.filter(
          (route) =>
            routeSourceId(route) === source.id &&
            (route.trigger.kind === "schedule"
              ? eventType === `schedule:${route.id}`
              : route.trigger.eventType === eventType),
        ).length;
      return (
        routeCount(right.eventType) - routeCount(left.eventType) ||
        left.eventType.localeCompare(right.eventType)
      );
    });
    const rows = sourceEvents.flatMap<EventSwimlaneRow>((eventDefinition) => {
      const eventRoutes = routes.filter((route) => {
        if (routeSourceId(route) !== source.id) {
          return false;
        }
        return route.trigger.kind === "schedule"
          ? eventDefinition.eventType === `schedule:${route.id}`
          : route.trigger.eventType === eventDefinition.eventType;
      });
      if (eventRoutes.length === 0) {
        return [
          {
            sourceId: source.id,
            eventId: `${eventDefinition.source}:${eventDefinition.eventType}`,
            source: null,
            eventDefinition,
            route: null,
            dividerAfterSource: false,
          },
        ];
      }
      return eventRoutes.map((route, routeIndex) => ({
        sourceId: source.id,
        eventId: `${eventDefinition.source}:${eventDefinition.eventType}`,
        source: null,
        eventDefinition: routeIndex === 0 ? eventDefinition : null,
        route,
        dividerAfterSource: false,
      }));
    });

    if (rows.length === 0) {
      rows.push({
        sourceId: source.id,
        eventId: null,
        source: source,
        eventDefinition: null,
        route: null,
        dividerAfterSource: sourceIndex < sources.length - 1,
      });
      return rows;
    }

    rows[0] = { ...rows[0], source };
    rows[rows.length - 1] = {
      ...rows[rows.length - 1],
      dividerAfterSource: sourceIndex < sources.length - 1,
    };
    return rows;
  });
};

const latestWorkflowRunForRoute = (
  route: DashboardRoute,
  instances: DashboardWorkflowInstance[],
) => {
  return (
    instances.find((instance) => automationRouteMatchesWorkflowInstance(route, instance)) ?? null
  );
};

const routeDestinationLabel = (route: DashboardRoute) => {
  if (route.action.kind === "start_workflow") {
    return automationRouteWorkflowName(route) ?? "Unknown saved workflow";
  }
  if (route.action.kind === "send_workflow_event") {
    return route.action.target.kind === "instance_id"
      ? `Workflow · ${route.action.target.template}`
      : `Workflow from store · ${route.action.target.keyTemplate}`;
  }
  if (route.action.kind === "reclassify_event") {
    return `${route.action.source}:${route.action.eventType}`;
  }

  switch (route.action.targetScope.kind) {
    case "system":
      return "System scope";
    case "org":
      return `Organization · ${route.action.targetScope.orgIdTemplate}`;
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
    case "reclassify_event":
      return `Emit ${route.action.source}:${route.action.eventType}`;
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
}: {
  dotClassName: string;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClassName}`} aria-hidden="true" />
        <span className="text-[var(--bo-muted)]">{icon}</span>
        <h2 className="text-sm font-semibold text-[var(--bo-fg)]">{title}</h2>
      </div>
      <p className="mt-1 pl-6 text-[11px] text-[var(--bo-muted-2)]">{description}</p>
    </div>
  );
}

function SourceCard({
  source,
  selected,
  muted,
  onSelect,
}: {
  source: DashboardSource;
  selected: boolean;
  muted: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex h-full w-full min-w-0 items-center gap-2.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,opacity,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${
        selected ? "ring-2 ring-lime-600/35" : ""
      } ${muted ? "opacity-35" : ""}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-lime-500/10 text-lime-700 dark:text-lime-300">
        <SourceIcon source={source.id} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-[var(--bo-fg)]">
          {source.label}
        </span>
        <span className="mt-0.5 block truncate text-[10px] tracking-[0.12em] text-[var(--bo-muted-2)] uppercase">
          Event source
        </span>
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
      className={`group h-full w-full min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${
        selected ? "ring-2 ring-orange-600/30" : ""
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-orange-500/10 text-orange-700 dark:text-orange-300">
          {route.trigger.kind === "schedule" ? (
            <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.8} />
          ) : (
            <Zap className="h-3.5 w-3.5" strokeWidth={1.8} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[13px] font-semibold text-[var(--bo-fg)]">{route.name}</p>
            <span className="shrink-0 text-[9px] font-semibold tracking-[0.12em] text-[var(--bo-muted-2)] uppercase">
              P{route.priority}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] font-semibold tracking-[0.13em] text-orange-700 uppercase dark:text-orange-300">
            {triggerLabel}
            {route.enabled ? "" : " · Disabled"}
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
            {triggerDetail}
          </p>
        </div>
      </div>
    </button>
  );
}

function EventCard({
  eventDefinition,
  selected,
  onSelect,
}: {
  eventDefinition: DashboardEventDefinitionWithSource;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex h-full w-full min-w-0 items-center gap-2.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${selected ? "ring-2 ring-orange-600/30" : ""}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-orange-500/10 text-orange-700 dark:text-orange-300">
        <Zap className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12px] font-semibold text-[var(--bo-fg)]">
          {eventDefinition.eventType.startsWith("schedule:")
            ? "Scheduled occurrence"
            : eventDefinition.eventType}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--bo-muted-2)]">
          {eventDefinition.label}
        </span>
      </span>
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
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] uppercase ${className}`}
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

const routeActionAppearance = (kind: DashboardRoute["action"]["kind"]) => {
  switch (kind) {
    case "start_workflow":
      return {
        icon: <Workflow className="h-3.5 w-3.5" strokeWidth={1.8} />,
        iconClassName: "bg-rose-950/8 text-rose-950 dark:bg-rose-300/10 dark:text-rose-200",
        labelClassName: "text-rose-800 dark:text-rose-300",
        selectedClassName: "ring-2 ring-rose-900/25 dark:ring-rose-300/25",
      };
    case "send_workflow_event":
      return {
        icon: <Send className="h-3.5 w-3.5" strokeWidth={1.8} />,
        iconClassName: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
        labelClassName: "text-sky-700 dark:text-sky-300",
        selectedClassName: "ring-2 ring-sky-600/30 dark:ring-sky-300/25",
      };
    case "forward_event":
      return {
        icon: <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />,
        iconClassName: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
        labelClassName: "text-violet-700 dark:text-violet-300",
        selectedClassName: "ring-2 ring-violet-600/30 dark:ring-violet-300/25",
      };
    case "reclassify_event":
      return {
        icon: <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />,
        iconClassName: "bg-lime-500/10 text-lime-700 dark:text-lime-300",
        labelClassName: "text-lime-700 dark:text-lime-300",
        selectedClassName: "ring-2 ring-lime-600/30 dark:ring-lime-300/25",
      };
  }

  throw new Error("Unsupported automation route action kind.");
};

function ActionCard({
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
  const appearance = routeActionAppearance(route.action.kind);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`group h-full w-full min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow,transform] hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] active:scale-[0.96] ${
        selected ? appearance.selectedClassName : ""
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center ${appearance.iconClassName}`}
        >
          {appearance.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-[var(--bo-fg)]">
                {destination}
              </p>
              <p className={`mt-0.5 truncate text-[11px] font-medium ${appearance.labelClassName}`}>
                {route.action.kind === "reclassify_event" && route.trigger.kind === "event"
                  ? `${route.trigger.source}:${route.trigger.eventType} → ${route.action.source}:${route.action.eventType}`
                  : routeActionLabel(route)}
              </p>
              {route.action.kind === "reclassify_event" ? (
                <p className="mt-1 truncate font-mono text-[10px] text-[var(--bo-muted-2)]">
                  {Object.keys(route.action.payload.fields).length} projected payload field
                  {Object.keys(route.action.payload.fields).length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
            {instance ? <WorkflowStatus status={instance.status} /> : null}
          </div>
          {instance ? (
            <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)] tabular-nums">
              {instance.instanceId} · {formatTimestamp(instance.updatedAt)}
            </p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function DashboardRouteGrid({
  sources,
  routes,
  workflowInstances,
  activeSource,
  selectionKind,
  selectionId,
  routesLoading,
  onSelectSource,
  onSelectTrigger,
  onSelectAction,
}: {
  sources: readonly DashboardSource[];
  routes: readonly DashboardRoute[];
  workflowInstances: DashboardWorkflowInstance[];
  activeSource: DashboardSource | null;
  selectionKind: DashboardSelectionKind | null;
  selectionId: string;
  routesLoading: boolean;
  onSelectSource: (source: DashboardSource) => void;
  onSelectTrigger: (route: DashboardRoute) => void;
  onSelectAction: (route: DashboardRoute) => void;
}) {
  const gridRows = dashboardGridRows(sources, routes);
  const loadingRowSourceId = gridRows[0]?.sourceId ?? null;
  const selectedRoute =
    selectionKind === "trigger" || selectionKind === "action"
      ? (routes.find((route) => route.id === selectionId) ?? null)
      : null;
  const highlightedSourceId = selectedRoute ? routeSourceId(selectedRoute) : activeSource?.id;

  return (
    <div className="grid auto-rows-[5.75rem] grid-cols-[18rem_minmax(20rem,1fr)_minmax(22rem,1.1fr)] items-stretch gap-x-3 px-3">
      {gridRows.map((row) => {
        const { source, route } = row;
        const latestInstance = route ? latestWorkflowRunForRoute(route, workflowInstances) : null;
        const sourceMuted = Boolean(
          highlightedSourceId && source && source.id !== highlightedSourceId,
        );
        const rowMuted = Boolean(
          route &&
          (selectedRoute
            ? route.id !== selectedRoute.id
            : activeSource && routeSourceId(route) !== activeSource.id),
        );
        const emptyTriggerMuted = Boolean(
          highlightedSourceId && row.sourceId !== highlightedSourceId,
        );
        const dividerClassName = row.dividerAfterSource
          ? "border-b border-[color:var(--bo-border)]"
          : "";

        return (
          <Fragment key={route?.id ?? `${row.sourceId}:empty`}>
            <div className={`min-w-0 py-2.5 ${dividerClassName}`}>
              {source ? (
                <SourceCard
                  source={source}
                  selected={!selectedRoute && activeSource?.id === source.id}
                  muted={sourceMuted}
                  onSelect={() => {
                    onSelectSource(source);
                  }}
                />
              ) : null}
            </div>

            {route ? (
              <>
                <div
                  className={`min-w-0 py-2.5 transition-opacity ${dividerClassName} ${
                    route.enabled ? "" : "bg-[var(--bo-panel)]/45"
                  } ${rowMuted ? "opacity-35" : ""}`}
                >
                  <TriggerCard
                    route={route}
                    selected={selectionKind === "trigger" && selectionId === route.id}
                    onSelect={() => {
                      onSelectTrigger(route);
                    }}
                  />
                </div>
                <div
                  className={`min-w-0 py-2.5 transition-opacity ${dividerClassName} ${
                    route.enabled ? "" : "bg-[var(--bo-panel)]/45"
                  } ${rowMuted ? "opacity-35" : ""}`}
                >
                  <ActionCard
                    route={route}
                    instance={latestInstance}
                    selected={selectionKind === "action" && selectionId === route.id}
                    onSelect={() => {
                      onSelectAction(route);
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <div
                  className={`min-w-0 py-2.5 transition-opacity ${dividerClassName} ${emptyTriggerMuted ? "opacity-35" : ""}`}
                >
                  <div className="flex h-full items-center px-3 text-xs text-[var(--bo-muted-2)]">
                    {routesLoading
                      ? row.sourceId === loadingRowSourceId
                        ? "Synchronizing automation routes…"
                        : null
                      : "No triggers"}
                  </div>
                </div>
                <div className={`min-w-0 py-2.5 ${dividerClassName}`} />
              </>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function EventRouteGrid({
  rows,
  routes,
  workflowInstances,
  activeSource,
  selectionKind,
  selectionId,
  onSelectSource,
  onSelectEvent,
  onSelectTrigger,
  onSelectAction,
}: {
  rows: readonly EventSwimlaneRow[];
  routes: readonly DashboardRoute[];
  workflowInstances: DashboardWorkflowInstance[];
  activeSource: DashboardSource | null;
  selectionKind: DashboardSelectionKind | null;
  selectionId: string;
  onSelectSource: (source: DashboardSource) => void;
  onSelectEvent: (eventDefinition: DashboardEventDefinitionWithSource) => void;
  onSelectTrigger: (route: DashboardRoute) => void;
  onSelectAction: (route: DashboardRoute) => void;
}) {
  const selectedRoute =
    selectionKind === "trigger" || selectionKind === "action"
      ? (routes.find((route) => route.id === selectionId) ?? null)
      : null;
  const selectedEventId =
    selectionKind === "event"
      ? selectionId
      : selectedRoute?.trigger.kind === "event"
        ? `${selectedRoute.trigger.source}:${selectedRoute.trigger.eventType}`
        : selectedRoute
          ? `scheduler:schedule:${selectedRoute.id}`
          : null;
  const selectedSourceId =
    selectionKind === "source"
      ? selectionId
      : selectedRoute
        ? routeSourceId(selectedRoute)
        : selectedEventId
          ? (rows.find((row) => row.eventId === selectedEventId)?.sourceId ?? null)
          : (activeSource?.id ?? null);

  return (
    <div className="grid auto-rows-[5.75rem] grid-cols-[18rem_minmax(20rem,1fr)_minmax(22rem,1.1fr)] items-stretch gap-x-3 px-3">
      {rows.map((row, rowIndex) => {
        const source = row.source;
        const eventDefinition = row.eventDefinition;
        const route = row.route;
        const dividerClassName = row.dividerAfterSource
          ? "border-b border-[color:var(--bo-border)]"
          : "";
        const sourceMuted = Boolean(selectedSourceId && row.sourceId !== selectedSourceId);
        const eventMuted = selectedEventId ? row.eventId !== selectedEventId : sourceMuted;
        const routingMuted = selectedRoute
          ? route?.id !== selectedRoute.id
          : selectedEventId
            ? row.eventId !== selectedEventId
            : sourceMuted;
        return (
          <Fragment key={`${row.sourceId}:${row.eventId ?? "empty"}:${route?.id ?? rowIndex}`}>
            <div className={`min-w-0 py-2.5 ${dividerClassName}`}>
              {source ? (
                <SourceCard
                  source={source}
                  selected={selectionKind === "source" && selectionId === source.id}
                  muted={sourceMuted}
                  onSelect={() => {
                    onSelectSource(source);
                  }}
                />
              ) : null}
            </div>
            <div
              className={`min-w-0 py-2.5 transition-opacity ${dividerClassName} ${eventMuted ? "opacity-35" : ""}`}
            >
              {eventDefinition ? (
                <EventCard
                  eventDefinition={eventDefinition}
                  selected={
                    (selectionKind === "event" &&
                      selectionId === `${eventDefinition.source}:${eventDefinition.eventType}`) ||
                    (selectionKind === "trigger" &&
                      route?.trigger.kind === "schedule" &&
                      selectionId === route.id)
                  }
                  onSelect={() => {
                    if (route?.trigger.kind === "schedule") {
                      onSelectTrigger(route);
                      return;
                    }
                    onSelectEvent(eventDefinition);
                  }}
                />
              ) : route ? null : (
                <div className="flex h-full items-center px-3 text-xs text-[var(--bo-muted-2)]">
                  No registered events
                </div>
              )}
            </div>
            <div
              className={`min-w-0 py-2.5 transition-opacity ${dividerClassName} ${routingMuted ? "opacity-35" : ""}`}
            >
              {route ? (
                <ActionCard
                  route={route}
                  instance={latestWorkflowRunForRoute(route, workflowInstances)}
                  selected={selectionKind === "action" && selectionId === route.id}
                  onSelect={() => {
                    onSelectAction(route);
                  }}
                />
              ) : eventDefinition ? (
                <div className="flex h-full items-center px-3 text-xs text-[var(--bo-muted-2)]">
                  No routes
                </div>
              ) : null}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

const parseSelectionKind = (value: string | null): DashboardSelectionKind | null => {
  if (value === "workflow") {
    return "action";
  }
  if (value === "source" || value === "event" || value === "trigger" || value === "action") {
    return value;
  }
  return null;
};

export function AutomationSwimlaneDashboard({
  view = "workflows",
}: {
  view?: AutomationSwimlaneView;
}) {
  const { collections, selectedScope } = useOutletContext<AutomationLayoutContext>();
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const routesState = useAutomationRoutes(collections);
  const eventSourcesQuery = useLiveQuery(
    (query) =>
      query
        .from({ source: collections.eventSources })
        .orderBy(({ source }) => source.label, "asc")
        .select(({ source }) => ({
          id: source.source,
          label: source.label,
          description: source.description,
        })),
    [collections.eventSources],
  );
  const eventDefinitionsQuery = useLiveQuery(
    (query) =>
      query
        .from({ definition: collections.eventDefinitions })
        .orderBy(({ definition }) => definition.source, "asc")
        .orderBy(({ definition }) => definition.eventType, "asc")
        .select(({ definition }) => ({
          source: definition.source,
          eventType: definition.eventType,
          label: definition.label,
          payloadSchema: definition.payloadSchema,
        })),
    [collections.eventDefinitions],
  );
  const workflowsQuery = useLiveQuery(
    (query) =>
      query
        .from({ instance: collections.workflowInstances })
        .where(({ instance }) =>
          or(
            eq(instance.status, "active"),
            eq(instance.status, "waiting"),
            eq(instance.status, "paused"),
          ),
        )
        .orderBy(({ instance }) => instance.updatedAt, "desc")
        .orderBy(({ instance }) => instance.id, "desc")
        .limit(ACTIVE_WORKFLOW_LIMIT)
        .select(({ instance }) => ({
          id: instance.id,
          workflowName: instance.workflowName,
          remoteWorkflowName: instance.remoteWorkflowName,
          instanceId: instance.instanceId,
          status: instance.status,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt,
          completedAt: instance.completedAt,
          params: instance.params,
        })),
    [collections.workflowInstances],
  );

  const routes: DashboardRoute[] = routesState.routes;
  const dynamicEventDefinitions: DashboardEventDefinitionWithSource[] = (
    eventDefinitionsQuery.data ?? []
  ).map((eventDefinition) => ({
    ...eventDefinition,
    payloadSchema: eventDefinition.payloadSchema ?? null,
  }));
  const eventDefinitions: DashboardEventDefinitionWithSource[] = [
    ...listAutomationEventDescriptors().map((eventDefinition) => ({
      source: eventDefinition.source,
      eventType: eventDefinition.eventType,
      label: eventDefinition.label,
      payloadSchema: eventDefinition.payloadSchema ?? null,
    })),
    ...dynamicEventDefinitions,
  ].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.eventType.localeCompare(right.eventType),
  );
  const workflowInstances: DashboardWorkflowInstance[] = (workflowsQuery.data ?? []).map(
    ({ params, ...instance }) => {
      const scriptReference = codemodeWorkflowScriptReferenceSchema.safeParse(params);
      return {
        ...instance,
        workflowScriptPath: scriptReference.success ? scriptReference.data.program.filename : null,
      };
    },
  );
  const workflowRoutes = routes.filter(
    (route) =>
      route.action.kind === "start_workflow" || route.action.kind === "send_workflow_event",
  );
  const eventRoutes = routes.filter((route) => route.action.kind !== "start_workflow");
  const sources = dashboardSources({
    routes: view === "workflows" ? workflowRoutes : eventRoutes,
    eventSources: eventSourcesQuery.data ?? [],
    eventDefinitions,
    includeUnroutedSources: view === "events",
  });
  const eventRows =
    view === "events" ? eventSwimlaneRows(sources, eventDefinitions, eventRoutes) : [];
  const requestedSourceId = normalizedSourceId(searchParams.get(SOURCE_FILTER_PARAM) ?? "");
  const activeSource = sources.find((source) => source.id === requestedSourceId) ?? null;
  const selectionKind = parseSelectionKind(searchParams.get(SELECTION_KIND_PARAM));
  const selectionId = searchParams.get(SELECTION_ID_PARAM)?.trim() ?? "";
  const selectedRoute = routes.find((route) => route.id === selectionId) ?? null;
  const selectedSource = sources.find((source) => source.id === selectionId) ?? null;
  const selectedEvent =
    eventDefinitions.find(
      (eventDefinition) => `${eventDefinition.source}:${eventDefinition.eventType}` === selectionId,
    ) ?? eventRows.find((row) => row.eventId === selectionId)?.eventDefinition;
  const inspectorSelection: DashboardInspectorSelection | null =
    selectionKind === "source" && selectedSource
      ? {
          kind: "source",
          source: selectedSource,
          eventDefinitions: eventDefinitions.filter(
            (eventDefinition) => normalizedSourceId(eventDefinition.source) === selectedSource.id,
          ),
        }
      : selectionKind === "event" && selectedEvent
        ? { kind: "event", eventDefinition: selectedEvent }
        : selectionKind === "trigger" && selectedRoute
          ? { kind: "trigger", route: selectedRoute }
          : selectionKind === "action" && selectedRoute
            ? { kind: "action", route: selectedRoute }
            : null;
  const showInspector = view === "events" || inspectorSelection !== null;
  const errors = [
    routesState.status === "error" ? routesState.message : null,
    eventSourcesQuery.isError ? "Event source synchronization failed." : null,
    eventDefinitionsQuery.isError ? "Event catalog synchronization failed." : null,
    workflowsQuery.isError ? "Workflow synchronization failed." : null,
  ].filter((message): message is string => Boolean(message));

  const updateSelection = ({
    kind,
    id,
    workflowScriptId,
    clearSourceFilter = false,
  }: {
    kind: DashboardSelectionKind;
    id: string;
    workflowScriptId?: string;
    clearSourceFilter?: boolean;
  }) => {
    setSearchParams((currentSearchParams) => {
      const nextSearchParams = new URLSearchParams(currentSearchParams);
      const currentSelectionKind = parseSelectionKind(
        currentSearchParams.get(SELECTION_KIND_PARAM),
      );
      const isTogglingSelection =
        currentSelectionKind === kind && currentSearchParams.get(SELECTION_ID_PARAM) === id;

      if (clearSourceFilter) {
        nextSearchParams.delete(SOURCE_FILTER_PARAM);
      }
      if (isTogglingSelection) {
        nextSearchParams.delete(SELECTION_KIND_PARAM);
        nextSearchParams.delete(SELECTION_ID_PARAM);
        nextSearchParams.delete(WORKFLOW_SCRIPT_ID_PARAM);
        return nextSearchParams;
      }

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
    <section className="flex w-full max-w-none flex-1 flex-col space-y-3 antialiased">
      {errors.length > 0 ? (
        <AutomationNotice tone="error">
          <p className="text-xs tracking-[0.22em] uppercase">
            Some dashboard data could not be synchronized
          </p>
          <p className="mt-2 text-sm">{errors.join(" ")}</p>
        </AutomationNotice>
      ) : null}

      <div
        className={`grid min-w-0 flex-1 gap-3 ${
          showInspector ? "xl:grid-cols-[minmax(0,1fr)_28rem]" : ""
        }`}
      >
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
                      ? `Highlighting routes from ${activeSource.label}`
                      : view === "events"
                        ? "Available event sources are always visible"
                        : "Sources with configured workflow routes"
                  }
                />
                <LaneHeader
                  dotClassName="bg-[#c47c31]"
                  icon={<Zap className="h-3 w-3" strokeWidth={1.8} />}
                  title={view === "workflows" ? "When" : "Events"}
                  description={
                    view === "workflows"
                      ? "Events, schedules, matchers, and priority"
                      : "Every registered or routed event"
                  }
                />
                <LaneHeader
                  dotClassName="bg-[#6b5f73]"
                  icon={<Braces className="h-3 w-3" strokeWidth={1.8} />}
                  title={view === "workflows" ? "Then" : "Routing"}
                  description={
                    view === "workflows"
                      ? "Workflow starts and workflow events"
                      : "Every configured route action"
                  }
                />
              </div>

              {view === "workflows" ? (
                <DashboardRouteGrid
                  sources={sources}
                  routes={workflowRoutes}
                  workflowInstances={workflowInstances}
                  activeSource={activeSource}
                  selectionKind={selectionKind}
                  selectionId={selectionId}
                  routesLoading={routesState.status === "loading"}
                  onSelectSource={(source) => {
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
                  onSelectTrigger={(route) => {
                    updateSelection({ kind: "trigger", id: route.id, clearSourceFilter: true });
                  }}
                  onSelectAction={(route) => {
                    updateSelection({
                      kind: "action",
                      id: route.id,
                      clearSourceFilter: true,
                      workflowScriptId:
                        route.action.kind === "start_workflow"
                          ? toAutomationScriptIdFromAbsolutePath(route.action.workflowScriptPath)
                          : undefined,
                    });
                  }}
                />
              ) : (
                <EventRouteGrid
                  rows={eventRows}
                  routes={eventRoutes}
                  workflowInstances={workflowInstances}
                  activeSource={activeSource}
                  selectionKind={selectionKind}
                  selectionId={selectionId}
                  onSelectSource={(source) => {
                    updateSelection({ kind: "source", id: source.id });
                  }}
                  onSelectEvent={(eventDefinition) => {
                    updateSelection({
                      kind: "event",
                      id: `${eventDefinition.source}:${eventDefinition.eventType}`,
                      clearSourceFilter: true,
                    });
                  }}
                  onSelectTrigger={(route) => {
                    updateSelection({ kind: "trigger", id: route.id, clearSourceFilter: true });
                  }}
                  onSelectAction={(route) => {
                    updateSelection({
                      kind: "action",
                      id: route.id,
                      workflowScriptId:
                        route.action.kind === "start_workflow"
                          ? toAutomationScriptIdFromAbsolutePath(route.action.workflowScriptPath)
                          : undefined,
                    });
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {showInspector ? (
          <DashboardInspector
            selection={inspectorSelection}
            workflowSource={loaderData.workflowSource}
            runtimeToolCatalog={loaderData.runtimeToolCatalog}
            collections={collections}
            scriptsPath={filesScopeBasePath(selectedScope)}
            eventsCatalogPath={automationScopeTabPath(selectedScope, "events-catalog")}
            scope={selectedScope}
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
        ) : null}
      </div>
    </section>
  );
}

export default function BackofficeAutomationDashboard() {
  return <AutomationSwimlaneDashboard />;
}
