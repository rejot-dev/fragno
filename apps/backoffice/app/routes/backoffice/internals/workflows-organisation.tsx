import { Link, Outlet, useLoaderData, useLocation, useParams } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/workflows-organisation";
import {
  loadWorkflowInstanceSummaries,
  parsePageSize,
  resolveWorkflowFragment,
  WORKFLOW_FRAGMENT_META,
  WORKFLOW_ORG_FRAGMENTS,
  WorkflowApiError,
  type WorkflowOrgFragment,
} from "./workflows-data";
import { formatTimestamp, getWorkflowStatusBadgeClasses } from "./workflows-shared";

type WorkflowsOrgLoaderData = {
  orgId: string;
  organisationName: string | null;
  fragment: WorkflowOrgFragment;
  configured: boolean;
  workflows: string[];
  instances: Awaited<ReturnType<typeof loadWorkflowInstanceSummaries>>["instances"];
  warnings: string[];
  error: string | null;
};

export async function loader({
  request,
  params,
  context,
}: Route.LoaderArgs): Promise<WorkflowsOrgLoaderData> {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const fragment = resolveWorkflowFragment(params.fragment);
  if (!fragment) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));

  try {
    const { workflows, instances, warnings } = await loadWorkflowInstanceSummaries({
      request,
      context,
      orgId: params.orgId,
      fragment,
      pageSize,
    });

    return {
      orgId: params.orgId,
      organisationName: organisation.name ?? null,
      fragment,
      configured: true,
      workflows,
      instances,
      warnings,
      error: null,
    } satisfies WorkflowsOrgLoaderData;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load workflows.";
    const isNotConfigured =
      error instanceof WorkflowApiError &&
      error.status === 400 &&
      message.toLowerCase().includes("not configured");

    return {
      orgId: params.orgId,
      organisationName: organisation.name ?? null,
      fragment,
      configured: !isNotConfigured,
      workflows: [],
      instances: [],
      warnings: [],
      error: isNotConfigured ? null : message,
    } satisfies WorkflowsOrgLoaderData;
  }
}

export function meta({ data }: Route.MetaArgs) {
  const orgLabel = data?.organisationName ?? data?.orgId ?? "organisation";
  return [{ title: `Workflows · ${orgLabel}` }];
}

export default function BackofficeWorkflowsOrganisation() {
  const { orgId, organisationName, fragment, configured, workflows, instances, warnings, error } =
    useLoaderData<typeof loader>();
  const location = useLocation();
  const params = useParams();

  const selectedWorkflowName = params.workflowName ?? null;
  const selectedInstanceId = params.instanceId ?? null;
  const isDetailRoute = Boolean(selectedWorkflowName && selectedInstanceId);

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  const baseScopePath = `/backoffice/internals/workflows/${orgId}`;
  const fragmentBasePath = `${baseScopePath}/${fragment}`;
  const fragmentMeta = WORKFLOW_FRAGMENT_META[fragment];
  const fragmentLabel = fragmentMeta.label;
  const configurePath = fragmentMeta.configurePath(orgId);

  const searchParams = new URLSearchParams(location.search);
  const fragmentTabHref = (fragmentId: WorkflowOrgFragment) => {
    const query = searchParams.toString();
    const tabBasePath = `${baseScopePath}/${fragmentId}`;
    return query ? `${tabBasePath}?${query}` : tabBasePath;
  };
  const fragmentTabs = WORKFLOW_ORG_FRAGMENTS.map((fragmentId) => ({
    id: fragmentId,
    label: WORKFLOW_FRAGMENT_META[fragmentId].label,
    to: fragmentTabHref(fragmentId),
    disabled: false,
  }));

  return (
    <div className="min-w-0 space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "Workflows", to: "/backoffice/internals/workflows" },
          { label: organisationName ?? orgId },
        ]}
        eyebrow="Internals"
        title={`Workflow instances · ${organisationName ?? orgId}`}
        description="Review workflow execution state, current step, and event history for this organisation."
        actions={
          <Link
            to="/backoffice/internals/workflows"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to scopes
          </Link>
        }
      />

      <div
        role="tablist"
        aria-label="Workflow fragments"
        className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
      >
        {fragmentTabs.map((tab) => {
          const isActive = fragment === tab.id;
          const className = isActive
            ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
            : tab.disabled
              ? "cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-60"
              : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

          if (tab.disabled) {
            return (
              <span
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-disabled="true"
                className={className}
              >
                {tab.label}
              </span>
            );
          }

          return (
            <Link
              key={tab.id}
              to={tab.to}
              role="tab"
              aria-selected={isActive}
              className={className}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <div
          className={`${listVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Workflow queue
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                {fragmentLabel} workflow instances
              </h2>
              <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                {workflows.length} workflow{workflows.length === 1 ? "" : "s"} registered
              </p>
            </div>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {instances.length} shown
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {error ? (
              <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            ) : !configured ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                {fragmentLabel} is not configured for this organisation yet.
                <Link
                  to={configurePath}
                  className="ml-2 inline-flex text-[var(--bo-accent)] hover:text-[var(--bo-accent-strong)]"
                >
                  Configure {fragmentLabel}
                </Link>
              </div>
            ) : workflows.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                No workflows are registered for this fragment runtime.
              </div>
            ) : instances.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                No workflow instances were found for the registered workflows.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  {instances.map((instance) => {
                    const isSelected =
                      selectedWorkflowName === instance.workflowName &&
                      selectedInstanceId === instance.instanceId;
                    const detailPath = `${fragmentBasePath}/${encodeURIComponent(instance.workflowName)}/${encodeURIComponent(instance.instanceId)}`;
                    const detailHref = location.search
                      ? `${detailPath}${location.search}`
                      : detailPath;

                    return (
                      <Link
                        key={`${instance.workflowName}:${instance.instanceId}`}
                        to={detailHref}
                        aria-label={`View workflow instance ${instance.workflowName} ${instance.instanceId}`}
                        className={
                          isSelected
                            ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-3 text-[var(--bo-accent-fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                            : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                        }
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p
                              className={
                                isSelected
                                  ? "truncate font-semibold text-[var(--bo-accent-fg)]"
                                  : "truncate font-semibold text-[var(--bo-fg)]"
                              }
                            >
                              {instance.workflowName}
                            </p>
                            <p
                              className={
                                isSelected
                                  ? "mt-1 truncate font-mono text-[11px] text-[var(--bo-accent-fg)]/80"
                                  : "mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]"
                              }
                              title={instance.instanceId}
                            >
                              {instance.instanceId}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 border px-2 py-1 text-[9px] tracking-[0.16em] uppercase ${getWorkflowStatusBadgeClasses(instance.status)}`}
                          >
                            {instance.status}
                          </span>
                        </div>
                        <p className="mt-2 text-[11px] text-[var(--bo-muted-2)]">
                          {formatTimestamp(instance.createdAt) || "Unknown"}
                        </p>
                      </Link>
                    );
                  })}
                </div>

                {warnings.length > 0 ? (
                  <div className="border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                    {warnings.join(" ")}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div
          className={`${detailVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <Outlet />
        </div>
      </section>
    </div>
  );
}
