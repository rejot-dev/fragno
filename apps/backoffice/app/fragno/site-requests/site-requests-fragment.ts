import { instantiate } from "@fragno-dev/core";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { siteRequestsFragmentDefinition } from "./definition";

export const createSiteRequestsServer = (runtime: BackofficeFragmentRuntimeOptions) =>
  instantiate(siteRequestsFragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      databaseAdapter: runtime.adapters.createAdapter({ kind: "site-requests" }),
      transactionInstrumentation: runtime.transactionInstrumentation,
      mountRoute: "/api/site-requests",
    })
    .build();

export type SiteRequestsFragment = ReturnType<typeof createSiteRequestsServer>;
