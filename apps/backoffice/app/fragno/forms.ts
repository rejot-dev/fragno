import { createFormsFragment, type FormsConfig } from "@fragno-dev/forms";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

/** Creates the system-scoped Forms fragment server backed by its Durable Object database. */
export function createFormsServer(
  config: FormsConfig,
  runtime: BackofficeFragmentRuntimeOptions,
): ReturnType<typeof createFormsFragment> {
  return createFormsFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({ kind: "forms" }),
    mountRoute: "/api/forms",
  });
}

export type FormsFragment = ReturnType<typeof createFormsServer>;
