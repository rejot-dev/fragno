import type {
  OrchestrationGraphItem,
  OrchestrationGraphItemKind,
} from "@fragno-private/design-system/orchestration-graph-model";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

// The dashboard shows one workflow run in place of its Automations table. The run lives in the
// URL, so browser back, reload, and links from elsewhere all reach it.
const RUN_WORKFLOW_PARAM = "workflow";
const RUN_INSTANCE_PARAM = "run";
// The orchestration selection lives in the URL too, so links can point at a route or an event.
const SELECTION_KIND_PARAM = "selection";
const SELECTION_ID_PARAM = "selected";
// The loader reads the selected workflow's source; the page derives it from the selection.
export const WORKFLOW_SCRIPT_PARAM = "workflowScript";
const SELECTION_KINDS: readonly OrchestrationGraphItemKind[] = [
  "source",
  "event",
  "route",
  "target",
];

export function dashboardPath(scope: BackofficeRouteScope): string {
  return `/backoffice/dashboard/${backofficeRouteScopePath(scope)}`;
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

export function dashboardSelectionPath(
  scope: BackofficeResolvedScope,
  item: OrchestrationGraphItem,
): string {
  const search = new URLSearchParams({
    [SELECTION_KIND_PARAM]: item.kind,
    [SELECTION_ID_PARAM]: item.id,
  });
  return `${dashboardPath(backofficeRouteScopeFromResolvedScope(scope))}?${search.toString()}`;
}

export function dashboardSelection(searchParams: URLSearchParams): OrchestrationGraphItem | null {
  const kind = SELECTION_KINDS.find(
    (candidate) => candidate === searchParams.get(SELECTION_KIND_PARAM),
  );
  const id = searchParams.get(SELECTION_ID_PARAM);
  return kind && id ? { kind, id } : null;
}

/** Keeps every other parameter, such as an opened run, while the selection changes. */
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
