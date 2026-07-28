import { Link, Outlet } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import {
  fetchAutomationAdapterIdentity,
  fetchAutomationProjects,
} from "../automations/data.server";
import type { Route } from "./+types/scope-layout";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  createMarketplaceScopeOptions,
  marketplaceScopeFromRouteParams,
  marketplaceScopeTabPath,
  resolveMarketplaceUiScope,
  type MarketplaceScopeOption,
  type MarketplaceTab,
  type MarketplaceUiScope,
} from "./scope";

const MARKETPLACE_TABS = [
  { id: "marketplace" as const, label: "Marketplace" },
  { id: "installed" as const, label: "Installed" },
  { id: "my-listings" as const, label: "My listings" },
];

const currentTabFromPath = (pathname: string): MarketplaceTab => {
  const segment = pathname.replace(/\/+$/u, "").split("/").at(-1);
  if (segment === "installed" || segment === "my-listings") {
    return segment;
  }
  return "marketplace";
};

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisations = me.organizations.map((entry) => entry.organization);
  const routeScope = marketplaceScopeFromRouteParams(params);
  const projectOrgId =
    routeScope.kind === "org" || routeScope.kind === "project"
      ? routeScope.orgId
      : (me.activeOrganization?.organization.id ?? organisations[0]?.id ?? null);
  if (!projectOrgId && routeScope.kind !== "user") {
    throw new Response("Not Found", { status: 404 });
  }

  const projectsResult = projectOrgId
    ? await fetchAutomationProjects(request, context, projectOrgId)
    : { projects: [], projectsError: null };
  if (routeScope.kind === "project" && projectsResult.projectsError) {
    throw new Response(projectsResult.projectsError, { status: 502 });
  }

  const selectedScope = resolveMarketplaceUiScope({
    params,
    organisations,
    projects: projectsResult.projects,
    user: me.user,
  });
  const currentTab = currentTabFromPath(url.pathname);
  const ingestionOrganizations =
    routeScope.kind === "user"
      ? organisations
      : organisations.filter(({ id }) => id === routeScope.orgId);
  const ingestionCollectionSources = await Promise.all(
    ingestionOrganizations.map(async (organization) => ({
      organizationId: organization.id,
      organizationName: organization.name ?? organization.id,
      source: {
        scope: { kind: "org" as const, orgId: organization.id },
        adapterIdentity: await fetchAutomationAdapterIdentity(request, context, {
          kind: "org",
          orgId: organization.id,
        }),
      },
    })),
  );

  return {
    selectedScope,
    ingestionCollectionSources,
    scopeOptions: createMarketplaceScopeOptions({
      organisations,
      projects: projectsResult.projects,
      user: me.user,
      currentTab,
      projectOrgId,
    }),
    projectsError: projectsResult.projectsError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Marketplace · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeMarketplaceScopeLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/u, "");
  const activeTab = currentTabFromPath(currentPath);

  return (
    <div className="space-y-4">
      <MarketplaceHeader selectedScope={loaderData.selectedScope} />
      <MarketplaceScopePicker
        selectedScope={loaderData.selectedScope}
        scopeOptions={loaderData.scopeOptions}
        projectsError={loaderData.projectsError}
      />
      <MarketplaceTabs selectedScope={loaderData.selectedScope} activeTab={activeTab} />
      <Outlet
        context={
          {
            selectedScope: loaderData.selectedScope,
            ingestionCollectionSources: loaderData.ingestionCollectionSources,
          } satisfies MarketplaceLayoutContext
        }
      />
    </div>
  );
}

function MarketplaceHeader({ selectedScope }: { selectedScope: MarketplaceUiScope }) {
  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Marketplace", to: "/backoffice/marketplace" },
        { label: selectedScope.label },
      ]}
      eyebrow="Automation exchange"
      title={`Marketplace for ${selectedScope.label}`}
      description="Discover reusable automations, inspect what is installed in this workspace, and manage listings owned by the selected scope."
      actions={
        selectedScope.kind === "org" ? (
          <Link
            to={`/backoffice/marketplace/publish?ownerOrgId=${encodeURIComponent(selectedScope.orgId)}`}
            className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
          >
            New draft
          </Link>
        ) : null
      }
    />
  );
}

function MarketplaceScopePicker({
  selectedScope,
  scopeOptions,
  projectsError,
}: {
  selectedScope: MarketplaceUiScope;
  scopeOptions: MarketplaceScopeOption[];
  projectsError: string | null;
}) {
  const selectedId =
    selectedScope.kind === "project"
      ? `project:${selectedScope.projectId}`
      : selectedScope.kind === "org"
        ? `org:${selectedScope.orgId}`
        : `user:${selectedScope.userId}`;

  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Scope</p>
          <p className="mt-1 text-sm text-[var(--bo-muted)]">
            Select the workspace whose installations and listings you want to inspect.
          </p>
        </div>
        {projectsError ? (
          <p className="text-xs text-red-700 dark:text-red-200">{projectsError}</p>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {scopeOptions.map((option) => {
          const isActive = option.id === selectedId;
          return (
            <Link
              key={option.id}
              to={option.to}
              className={
                isActive
                  ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-left text-[var(--bo-accent-fg)]"
                  : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              }
            >
              <span className="block text-[10px] font-semibold tracking-[0.22em] uppercase">
                {option.kind}
              </span>
              <span className="mt-1 block text-sm font-medium text-[var(--bo-fg)]">
                {option.label}
              </span>
              <span className="mt-1 block text-xs text-[var(--bo-muted-2)]">
                {option.description}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function MarketplaceTabs({
  selectedScope,
  activeTab,
}: {
  selectedScope: MarketplaceUiScope;
  activeTab: MarketplaceTab;
}) {
  return (
    <div
      role="tablist"
      aria-label="Marketplace backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {MARKETPLACE_TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Link
            key={tab.id}
            to={marketplaceScopeTabPath(selectedScope, tab.id)}
            role="tab"
            aria-selected={isActive}
            className={
              isActive
                ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
