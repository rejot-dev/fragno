import type {
  OrchestrationGraphItem,
  OrchestrationGraphItemKind,
} from "@fragno-private/design-system/orchestration/orchestration-graph-model";
import type { ShouldRevalidateFunctionArgs } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

// The overview shows one workflow run above its other panels. The run lives in the URL, so browser
// back, reload, and links from elsewhere all reach it.
const RUN_WORKFLOW_PARAM = "workflow";
const RUN_INSTANCE_PARAM = "run";
// The orchestration selection lives in the URL too, so links can point at a route or an event.
const SELECTION_KIND_PARAM = "selection";
const SELECTION_ID_PARAM = "selected";
// The loader reads the selected workflow's source; the page derives it from the selection.
export const WORKFLOW_SCRIPT_PARAM = "workflowScript";
// Which view of the Map shows: its graph, or an organization's universe, which the loader reads.
const MAP_VIEW_PARAM = "view";

/**
 * Selecting in the orchestration graph only changes the URL; a route that shows it loads again
 * once the selected workflow's source does, or the Map switches between its graph and universe.
 */
export function shouldRevalidateOrchestration({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }
  return [WORKFLOW_SCRIPT_PARAM, MAP_VIEW_PARAM].some(
    (param) => currentUrl.searchParams.get(param) !== nextUrl.searchParams.get(param),
  );
}

const SELECTION_KINDS: readonly OrchestrationGraphItemKind[] = [
  "inlet",
  "source",
  "event",
  "route",
  "target",
];

export function dashboardPath(scope: BackofficeRouteScope): string {
  return `/backoffice/dashboard/${backofficeRouteScopePath(scope)}`;
}

// The open trace, the node selected in it, and what the list shows live in the URL, so all three
// can be linked to and survive a reload.
const TRACE_PARAM = "trace";
const TRACE_NODE_PARAM = "node";
const ACTIVITY_FILTER_PARAM = "show";

/** Which traces the Activity list shows; `all` folds the ones nothing acted on out of the way. */
export type ActivityFilter = "all" | "failed" | "scheduled" | "agents";

const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "failed", "scheduled", "agents"];

export function dashboardActivityPath(
  scope: BackofficeRouteScope,
  { trace, filter }: { trace: string | null; filter: ActivityFilter },
): string {
  const search = new URLSearchParams();
  if (filter !== "all") {
    search.set(ACTIVITY_FILTER_PARAM, filter);
  }
  if (trace !== null) {
    search.set(TRACE_PARAM, trace);
  }
  const query = search.toString();
  return `${dashboardPath(scope)}/activity${query === "" ? "" : `?${query}`}`;
}

export function dashboardActivityFilter(searchParams: URLSearchParams): ActivityFilter {
  return (
    ACTIVITY_FILTERS.find((filter) => filter === searchParams.get(ACTIVITY_FILTER_PARAM)) ?? "all"
  );
}

export function dashboardOpenedTrace(searchParams: URLSearchParams): string | null {
  return searchParams.get(TRACE_PARAM);
}

export function dashboardSelectedTraceNode(searchParams: URLSearchParams): string | null {
  return searchParams.get(TRACE_NODE_PARAM);
}

/**
 * Pins the trace along with the selection, because without it the page opens the newest trace,
 * which a selection link would outlive. `null` clears the selection, which shows the origin.
 */
export function withSelectedTraceNode(
  searchParams: URLSearchParams,
  rootEventId: string,
  nodeId: string | null,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.set(TRACE_PARAM, rootEventId);
  if (nodeId === null) {
    next.delete(TRACE_NODE_PARAM);
  } else {
    next.set(TRACE_NODE_PARAM, nodeId);
  }
  return next;
}

export function dashboardRunPath(
  scope: BackofficeResolvedScope,
  run: WorkflowRunReference,
): string {
  const search = new URLSearchParams({
    [RUN_WORKFLOW_PARAM]: run.workflowName,
    [RUN_INSTANCE_PARAM]: run.instanceId,
  });
  return `${dashboardPath(backofficeRouteScopeFromResolvedScope(scope))}?${search.toString()}`;
}

export function dashboardOpenedRun(searchParams: URLSearchParams): WorkflowRunReference | null {
  const workflowName = searchParams.get(RUN_WORKFLOW_PARAM);
  const instanceId = searchParams.get(RUN_INSTANCE_PARAM);
  return workflowName && instanceId ? { workflowName, instanceId } : null;
}

export function dashboardMapPath(scope: BackofficeRouteScope): string {
  return `${dashboardPath(scope)}/map`;
}

/** The Map's views; only an organization's Map has a universe. */
export type DashboardMapView = "graph" | "universe";

export function dashboardMapViewPath(scope: BackofficeRouteScope, view: DashboardMapView): string {
  return view === "universe"
    ? `${dashboardMapPath(scope)}?${MAP_VIEW_PARAM}=universe`
    : dashboardMapPath(scope);
}

export function dashboardMapView(searchParams: URLSearchParams): DashboardMapView {
  return searchParams.get(MAP_VIEW_PARAM) === "universe" ? "universe" : "graph";
}

/** The Map with a route, event, source, or target selected in its graph. */
export function dashboardSelectionPath(
  scope: BackofficeResolvedScope,
  item: OrchestrationGraphItem,
): string {
  const search = new URLSearchParams({
    [SELECTION_KIND_PARAM]: item.kind,
    [SELECTION_ID_PARAM]: item.id,
  });
  return `${dashboardMapPath(backofficeRouteScopeFromResolvedScope(scope))}?${search.toString()}`;
}

export function dashboardSelection(searchParams: URLSearchParams): OrchestrationGraphItem | null {
  const kind = SELECTION_KINDS.find(
    (candidate) => candidate === searchParams.get(SELECTION_KIND_PARAM),
  );
  const id = searchParams.get(SELECTION_ID_PARAM);
  return kind && id ? { kind, id } : null;
}

/** Keeps every other parameter while the selection changes. */
export function withDashboardSelection(
  searchParams: URLSearchParams,
  item: OrchestrationGraphItem | null,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (item) {
    next.set(SELECTION_KIND_PARAM, item.kind);
    next.set(SELECTION_ID_PARAM, item.id);
  } else {
    next.delete(SELECTION_KIND_PARAM);
    next.delete(SELECTION_ID_PARAM);
    next.delete(WORKFLOW_SCRIPT_PARAM);
  }
  return next;
}
