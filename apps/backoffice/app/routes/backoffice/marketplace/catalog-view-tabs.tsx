import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

import { AutomationSubpageTabs } from "../automations/shared";
import { marketplaceCatalogAllPath } from "./navigation";
import { marketplaceScopeTabPath, type MarketplaceCatalog } from "./scope";

/** Each catalog opens on its curated listings, with every published listing one tab away. */
export function MarketplaceCatalogViewTabs({
  scope,
  catalog,
  activeView,
}: {
  scope: BackofficeScopeSelection;
  catalog: MarketplaceCatalog;
  activeView: "featured" | "all";
}) {
  return (
    <AutomationSubpageTabs
      tabs={[
        { id: "featured", label: "Featured", to: marketplaceScopeTabPath(scope, catalog) },
        { id: "all", label: "All", to: marketplaceCatalogAllPath(scope, catalog) },
      ]}
      activeTab={activeView}
      ariaLabel="Marketplace catalog views"
    />
  );
}
