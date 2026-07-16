import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { createBillingFragment } from "./index";

export const createBillingServer = (runtime: BackofficeFragmentRuntimeOptions) =>
  createBillingFragment({
    databaseAdapter: runtime.adapters.createAdapter({ kind: "billing" }),
    mountRoute: "/api/billing",
  });
