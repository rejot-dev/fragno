import { Menu } from "@base-ui/react/menu";
import { Fragment } from "react";
import { Link, Outlet } from "react-router";

import { BackofficeBreadcrumbs } from "@/components/backoffice/breadcrumbs";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { fetchAutomationProjects } from "../automations/data.server";
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

const MARKETPLACE_SCOPE_GROUPS = [
  { kind: "org", label: "Organisations" },
  { kind: "user", label: "Personal" },
  { kind: "project", label: "Projects" },
] as const;

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
  return {
    selectedScope,
    scopeOptions: createMarketplaceScopeOptions({
      organisations,
      projects: projectsResult.projects,
      user: me.user,
      selectedScope,
      currentLocation: { pathname: url.pathname, search: url.search },
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
      <MarketplaceWorkspaceHeader
        selectedScope={loaderData.selectedScope}
        scopeOptions={loaderData.scopeOptions}
        projectsError={loaderData.projectsError}
        activeTab={activeTab}
      />
      <Outlet
        context={
          {
            selectedScope: loaderData.selectedScope,
          } satisfies MarketplaceLayoutContext
        }
      />
    </div>
  );
}

function marketplaceScopeId(scope: MarketplaceUiScope) {
  switch (scope.kind) {
    case "org":
      return `org:${scope.orgId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
  }

  throw new Error("Unsupported Marketplace scope kind.");
}

function marketplaceScopeKindLabel(kind: MarketplaceUiScope["kind"]) {
  switch (kind) {
    case "org":
      return "Org";
    case "project":
      return "Project";
    case "user":
      return "User";
  }

  throw new Error("Unsupported Marketplace scope kind.");
}

function MarketplaceWorkspaceHeader({
  selectedScope,
  scopeOptions,
  projectsError,
  activeTab,
}: {
  selectedScope: MarketplaceUiScope;
  scopeOptions: MarketplaceScopeOption[];
  projectsError: string | null;
  activeTab: MarketplaceTab;
}) {
  const tabs = MARKETPLACE_TABS.map((tab) => ({
    ...tab,
    to: marketplaceScopeTabPath(selectedScope, tab.id),
    active: activeTab === tab.id,
  }));

  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Marketplace for {selectedScope.label}</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bo-product-code">MKT</span>
            <BackofficeBreadcrumbs
              items={[{ label: "Backoffice", to: "/backoffice" }, { label: "Marketplace" }]}
            />
          </div>
          <div className="flex w-full min-w-0 items-stretch gap-2 sm:w-auto sm:max-w-xl">
            {selectedScope.kind === "org" ? (
              <Link
                to={`/backoffice/marketplace/publish?ownerOrgId=${encodeURIComponent(selectedScope.orgId)}`}
                className="flex min-h-10 shrink-0 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
              >
                New draft
              </Link>
            ) : null}
            <MarketplaceScopeMenu
              selectedScope={selectedScope}
              scopeOptions={scopeOptions}
              projectsError={projectsError}
            />
          </div>
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
        <OverflowTabRow items={tabs} ariaLabel="Marketplace workspace sections" />
      </div>
    </section>
  );
}

function MarketplaceScopeMenu({
  selectedScope,
  scopeOptions,
  projectsError,
}: {
  selectedScope: MarketplaceUiScope;
  scopeOptions: MarketplaceScopeOption[];
  projectsError: string | null;
}) {
  const selectedId = marketplaceScopeId(selectedScope);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label={`Switch marketplace scope. Current context: ${selectedScope.label}`}
        className="group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] py-2 pr-2.5 pl-3 text-left transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:border-[color:var(--bo-accent)] data-[popup-open]:bg-[var(--bo-accent-bg)] sm:flex-none"
      >
        <span className="hidden shrink-0 text-[8px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase group-data-[popup-open]:text-[var(--bo-accent-fg)] lg:inline">
          Marketplace scope
        </span>
        <span
          className="hidden h-4 w-px shrink-0 bg-[var(--bo-border-strong)] lg:block"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            {marketplaceScopeKindLabel(selectedScope.kind)}
          </span>
          <span className="text-[var(--bo-muted-2)]" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
            {selectedScope.label}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180 group-data-[popup-open]:text-[var(--bo-accent-fg)]"
        >
          ▾
        </span>
      </Menu.Trigger>

      <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Menu.Positioner side="bottom" align="end" sideOffset={10} style={{ zIndex: 2147483647 }}>
          <Menu.Popup
            data-backoffice-root
            className="relative max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] origin-top-left overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left tracking-normal text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
          >
            <p className="px-2 py-1 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Switch marketplace scope
            </p>

            {MARKETPLACE_SCOPE_GROUPS.map((group) => {
              const options = scopeOptions.filter((option) => option.kind === group.kind);
              const showProjectsError = group.kind === "project" && projectsError;
              if (options.length === 0 && !showProjectsError) {
                return null;
              }

              return (
                <Fragment key={group.kind}>
                  <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
                  <Menu.Group className="space-y-1">
                    <Menu.GroupLabel className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      {group.label}
                    </Menu.GroupLabel>
                    {options.map((option) => {
                      const isCurrent = option.id === selectedId;
                      const content = (
                        <>
                          <span className="flex min-w-0 items-center justify-between gap-4">
                            <span className="truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
                              {option.label}
                            </span>
                            <span className="shrink-0 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                              {marketplaceScopeKindLabel(option.kind)}
                            </span>
                          </span>
                          <span className="truncate text-xs tracking-normal text-[var(--bo-muted-2)] normal-case">
                            {option.description}
                          </span>
                        </>
                      );
                      const className = isCurrent
                        ? "grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left text-[var(--bo-accent-fg)] outline-none"
                        : "grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left text-[var(--bo-muted)] outline-none transition-[background-color,border-color,color] duration-150 ease-out data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";

                      return isCurrent ? (
                        <Menu.Item key={option.id} disabled className={className}>
                          {content}
                        </Menu.Item>
                      ) : (
                        <Menu.Item
                          key={option.id}
                          render={<Link to={option.to} preventScrollReset />}
                          className={className}
                        >
                          {content}
                        </Menu.Item>
                      );
                    })}
                    {showProjectsError ? (
                      <p className="px-2 py-1.5 text-xs text-red-700 dark:text-red-200">
                        {projectsError}
                      </p>
                    ) : null}
                  </Menu.Group>
                </Fragment>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
