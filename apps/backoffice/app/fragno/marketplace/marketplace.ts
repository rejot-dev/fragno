import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { createMarketplaceFragment } from "./index";

export const createMarketplaceServer = (runtime: BackofficeFragmentRuntimeOptions) =>
  createMarketplaceFragment({
    databaseAdapter: runtime.adapters.createAdapter({ kind: "marketplace" }),
    mountRoute: "/api/marketplace",
  });
