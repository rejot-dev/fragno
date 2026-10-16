import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Outlet } from "react-router";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/scope-layout";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  marketplaceScopeTabPath,
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

/** System administrators browse the public Marketplace they curate from System scope. */
export async function loader({ context }: Route.LoaderArgs) {
  return { selectedScope: await requireScopeSelection(context) };
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
