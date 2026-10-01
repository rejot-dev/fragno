import type { ProjectConnectorFragmentConfig } from "@fragno-dev/project-connector-fragment/definition";

import { createProjectConnectorFragment } from "@fragno-dev/project-connector-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

/** Mounts Connector on a user-owned scoped database adapter. */
export function createProjectConnectorServer(
  config: ProjectConnectorFragmentConfig,
  runtime: BackofficeFragmentRuntimeOptions,
) {
  return createProjectConnectorFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({ kind: "projectConnector" }),
    mountRoute: "/api/project-connector",
  });
}

/** The route caller derives its response types from the mounted fragment. */
export type ProjectConnectorFragment = ReturnType<typeof createProjectConnectorServer>;
