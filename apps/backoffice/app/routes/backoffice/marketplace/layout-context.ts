import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

import type { MarketplaceUiScope } from "./scope";

export type MarketplaceLayoutContext = {
  selectedScope: MarketplaceUiScope;
  ingestionCollectionSources: Array<{
    organizationId: string;
    organizationName: string;
    source: AutomationCollectionSource;
  }>;
};
