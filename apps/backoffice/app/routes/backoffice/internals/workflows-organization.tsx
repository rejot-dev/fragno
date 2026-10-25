import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { ListRow, RowList } from "@fragno-private/design-system/list-row";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelRows,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Outlet, useLoaderData, useLocation, useParams } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/workflows-organization";
import { internalsScopeBasePath } from "./internals-scope";
import { loadWorkflowInstanceSummaries, parsePageSize, WorkflowApiError } from "./workflows-data";
import { formatTimestamp, workflowStatusTone } from "./workflows-shared";

type WorkflowsOrgLoaderData = {
  internalsBasePath: string;
  scopeLabel: string;
  configured: boolean;
  workflows: string[];
  instances: Awaited<ReturnType<typeof loadWorkflowInstanceSummaries>>["instances"];
  warnings: string[];
  error: string | null;
};

export async function loader({
  request,
  context,
  url,
}: Route.LoaderArgs): Promise<WorkflowsOrgLoaderData> {
  const { resolvedScope, execution } = requireRouteScope(context);
  const routeScope = backofficeRouteScopeFromResolvedScope(resolvedScope);
  const { scope } = execution;
  const internalsBasePath = internalsScopeBasePath(routeScope);
  const scopeLabel = backofficeContextScopeLabel(scope);
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));

  try {
    const { workflows, instances, warnings } = await loadWorkflowInstanceSummaries({
      request,
      context,
      scope,
      pageSize,
    });
    return {
      internalsBasePath,
      scopeLabel,
      configured: true,
      workflows,
      instances,
      warnings,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load workflows.";
    const isNotConfigured =
      error instanceof WorkflowApiError &&
      error.status === 400 &&
      message.toLowerCase().includes("not configured");
    return {
      internalsBasePath,
      scopeLabel,
      configured: !isNotConfigured,
      workflows: [],
      instances: [],
      warnings: [],
      error: isNotConfigured ? null : message,
    };
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  const scopeLabel = loaderData?.scopeLabel ?? "scope";
  return [{ title: `Workflows · ${scopeLabel}` }];
}

export default function BackofficeWorkflowsOrganization() {
  const { internalsBasePath, configured, workflows, instances, warnings, error } =
    useLoaderData<typeof loader>();
  const location = useLocation();
  const params = useParams();

  const isDetailRoute = Boolean(params.workflowName && params.instanceId);
  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  const baseScopePath = `${internalsBasePath}/workflows`;

  return (
    <section className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
      <div className={`${listVisibility} min-w-0`}>
        <SurfacePanel
          caption={`${instances.length} ${instances.length === 1 ? "instance" : "instances"} · ${workflows.length} ${workflows.length === 1 ? "workflow" : "workflows"}`}
          actions={null}
        >
          {error ? (
            <SurfacePanelBody>
              <InlineAlert>{error}</InlineAlert>
            </SurfacePanelBody>
          ) : !configured ? (
            <BackofficeSystemState
              tone="empty"
              label="Not configured"
              title="Workflows are not configured for this scope yet."
              flush
            />
          ) : workflows.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="No workflows are registered for this scope."
              flush
            />
          ) : instances.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="No workflow instances yet."
              description="Instances of the registered workflows appear here once they start."
              flush
            />
          ) : (
            <SurfacePanelRows>
              <RowList empty={null}>
                {instances.map((instance) => {
                  const detailPath = `${baseScopePath}/${encodeURIComponent(instance.workflowName)}/${encodeURIComponent(instance.instanceId)}`;
                  return (
                    <ListRow
                      key={`${instance.workflowName}:${instance.instanceId}`}
                      to={`${detailPath}${location.search}`}
                      leading={null}
                      title={instance.workflowName}
                      detail={`${instance.instanceId} · ${formatTimestamp(instance.createdAt) || "Unknown"}`}
                      trailing={
                        <BackofficeStatusLight tone={workflowStatusTone(instance.status)}>
                          {instance.status}
                        </BackofficeStatusLight>
                      }
                      expansion={null}
                    />
                  );
                })}
              </RowList>
            </SurfacePanelRows>
          )}
          {warnings.length > 0 ? (
            <p className="border-t border-[color:var(--bo-border)] px-4 py-3 text-xs text-pretty text-[var(--bo-muted)]">
              {warnings.join(" ")}
            </p>
          ) : null}
        </SurfacePanel>
      </div>

      <div className={`${detailVisibility} min-w-0`}>
        <Outlet />
      </div>
    </section>
  );
}
