import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Outlet } from "react-router";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { lookupAutomationProject } from "../automations/data.server";
import type { Route } from "./+types/scope-layout";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  marketplaceScopeTabPath,
  resolveMarketplaceBrowsingSelection,
  marketplaceCatalogsForScope,
  type MarketplaceCatalog,
  type MarketplaceTab,
} from "./scope";

const MARKETPLACE_CATALOG_LABELS = {
  marketplace: "Public",
  organization: "Organization",
} satisfies Record<MarketplaceCatalog, string>;

// Paths are /backoffice/marketplace/:scopeKind/:scopeId/:tab/...
const currentTabFromPath = (pathname: string): MarketplaceTab => {
  const segment = pathname.split("/")[5];
  return segment === "organization" || segment === "my-listings" ? segment : "marketplace";
};

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const selectedScope = await resolveMarketplaceBrowsingSelection({
    params,
    me,
    lookupProject: async (orgId, projectId) => {
      const projectLookup = await lookupAutomationProject(context, orgId, projectId);
      if (projectLookup.status === "error") {
        throw new Response(projectLookup.message, { status: 502 });
      }
      if (projectLookup.status === "not-found") {
        throw new Response("Not Found", { status: 404 });
      }
      return projectLookup.project;
    },
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
    <div className="flex flex-1 flex-col">
      <MarketplaceWorkspaceHeader selectedScope={loaderData.selectedScope} activeTab={activeTab} />
      <div className={`${backofficePageBodyClassName} flex flex-1 flex-col`}>
        <Outlet
          context={
            {
              selectedScope: loaderData.selectedScope,
            } satisfies MarketplaceLayoutContext
          }
        />
      </div>
    </div>
  );
}

function MarketplaceWorkspaceHeader({
  selectedScope,
  activeTab,
}: {
  selectedScope: BackofficeScopeSelection;
  activeTab: MarketplaceTab;
}) {
  const tabs = marketplaceCatalogsForScope(selectedScope).map((catalog) => ({
    id: catalog,
    label: MARKETPLACE_CATALOG_LABELS[catalog],
    to: marketplaceScopeTabPath(selectedScope, catalog),
    active: activeTab === catalog,
  }));

  return (
    <>
      <h1 className="sr-only">Marketplace for {selectedScope.label}</h1>
      <BackofficeTabHeader items={tabs} ariaLabel="Marketplace workspace sections" options={null} />
    </>
  );
}
