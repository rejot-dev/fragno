import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import { createAppInstallationsFragment } from "./fragment";

/** Organization-scoped storage is supplied by the dedicated AppInstallations object. */
export function createAppInstallationsServer(
  runtime: BackofficeFragmentRuntimeOptions,
  organizationId: string,
) {
  return createAppInstallationsFragment(
    { organizationId },
    {
      databaseAdapter: runtime.adapters.createAdapter({ kind: "app-installations" }),
      transactionInstrumentation: runtime.transactionInstrumentation,
      mountRoute: "/api/app-installations",
    },
  );
}
