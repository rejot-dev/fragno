import type { MarketplaceScope } from "@fragno-dev/backoffice-api/v0/marketplace";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { createMarketplaceFragment } from "./index";

export const createMarketplaceServer = (
  runtime: BackofficeFragmentRuntimeOptions,
  scope: MarketplaceScope,
) =>
  createMarketplaceFragment(
    { scope },
    {
      databaseAdapter: runtime.adapters.createAdapter({ kind: "marketplace" }),
      mountRoute: "/api/marketplace",
    },
  );
