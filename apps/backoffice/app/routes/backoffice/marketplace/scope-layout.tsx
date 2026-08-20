import { Link, Outlet } from "react-router";

import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { lookupAutomationProject } from "../automations/data.server";
import type { Route } from "./+types/scope-layout";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  marketplaceScopeFromRouteParams,
  marketplaceScopeTabPath,
  resolveMarketplaceUiScope,
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
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisations = me.organizations.map((entry) => entry.organization);
  const routeScope = marketplaceScopeFromRouteParams(params);
  const projectLookup =
    routeScope.kind === "project"
      ? await lookupAutomationProject(context, routeScope.orgId, routeScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw new Response(projectLookup.message, { status: 502 });
  }
  if (projectLookup?.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }

  const selectedScope = resolveMarketplaceUiScope({
    params,
    organisations,
    project: projectLookup?.status === "found" ? projectLookup.project : null,
    user: me.user,
  });
  return { selectedScope };
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
      <MarketplaceWorkspaceHeader selectedScope={loaderData.selectedScope} activeTab={activeTab} />
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

function MarketplaceWorkspaceHeader({
  selectedScope,
  activeTab,
}: {
  selectedScope: MarketplaceUiScope;
  activeTab: MarketplaceTab;
}) {
  const tabs = MARKETPLACE_TABS.map((tab) => ({
    ...tab,
    to: marketplaceScopeTabPath(selectedScope, tab.id),
    active: activeTab === tab.id,
  }));

  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-header-bg)]">
      <h1 className="sr-only">Marketplace for {selectedScope.label}</h1>
      {selectedScope.kind === "org" ? (
        <div className="flex justify-end border-b border-[color:var(--bo-border)] p-3 md:px-4">
          <Link
            to={`/backoffice/marketplace/publish?ownerOrgId=${encodeURIComponent(selectedScope.orgId)}`}
            className="flex min-h-10 shrink-0 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-accent-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
          >
            New draft
          </Link>
        </div>
      ) : null}

      <div className="bg-[var(--bo-header-bg)] p-2">
        <OverflowTabRow items={tabs} ariaLabel="Marketplace workspace sections" />
      </div>
    </section>
  );
}
