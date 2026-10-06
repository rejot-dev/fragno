import { useLocation } from "react-router";

import { AutomationSubpageTabs } from "../automations/shared";

const MARKETPLACE_PACKAGE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "workflows", label: "Workflows" },
  { id: "files", label: "Files" },
  { id: "install", label: "Install" },
] as const;

/** Package sections share the selected release, including the installation tab. */
export type MarketplacePackageTab = (typeof MARKETPLACE_PACKAGE_TABS)[number]["id"];

/** Unrecognized package tabs show the overview. */
export function marketplacePackageTabFromSearch(search: string): MarketplacePackageTab {
  const requestedTab = new URLSearchParams(search).get("artifactTab");
  return MARKETPLACE_PACKAGE_TABS.find((tab) => tab.id === requestedTab)?.id ?? "overview";
}

/** Overview and installation links clear file selections while preserving the selected release. */
export function buildMarketplacePackageTabPath(
  pathname: string,
  currentSearch: string,
  tab: MarketplacePackageTab,
): string {
  const search = new URLSearchParams(currentSearch);
  search.set("artifactTab", tab);
  if (tab === "overview" || tab === "install") {
    search.delete("artifactPath");
    search.delete("artifactContent");
  }
  return `${pathname}?${search}`;
}

/** Package navigation remains available while an installation is running or contents are unavailable. */
export function MarketplacePackageTabs() {
  const location = useLocation();
  return (
    <AutomationSubpageTabs
      tabs={MARKETPLACE_PACKAGE_TABS.map((tab) => ({
        ...tab,
        to: buildMarketplacePackageTabPath(location.pathname, location.search, tab.id),
      }))}
      activeTab={marketplacePackageTabFromSearch(location.search)}
      ariaLabel="Marketplace package sections"
    />
  );
}
