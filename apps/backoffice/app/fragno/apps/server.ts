import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { createAppsFragment } from "./fragment";

/** Creates the apps registry using the dedicated Apps object's database adapter. */
export function createAppsServer(runtime: BackofficeFragmentRuntimeOptions) {
  return createAppsFragment({
    databaseAdapter: runtime.adapters.createAdapter({ kind: "apps" }),
    transactionInstrumentation: runtime.transactionInstrumentation,
    mountRoute: "/api/apps",
  });
}
