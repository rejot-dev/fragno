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
