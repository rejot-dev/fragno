import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  projectConnectorFragmentDefinition,
  type ProjectConnectorFragmentConfig,
} from "./definition";
import { projectConnectorRoutes } from "./routes";

const routes = [projectConnectorRoutes] as const;

/** Creates a project-scoped connector with integrator-owned user authentication. */
export function createProjectConnectorFragment(
  config: ProjectConnectorFragmentConfig,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(projectConnectorFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

/** Client operations select only accounts previously verified and bound on the server. */
export function createProjectConnectorFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(projectConnectorFragmentDefinition, fragnoConfig, routes);
  return {
    useStatus: builder.createHook("/status"),
    useAccounts: builder.createHook("/accounts"),
    useProfile: builder.createHook("/accounts/:accountId/profile"),
    connect: builder.createMutator("POST", "/connection-requests"),
    refreshConnection: builder.createMutator(
      "POST",
      "/connection-requests/:requestId/refresh",
      (invalidate) => {
        invalidate("GET", "/accounts", {});
      },
    ),
    executeAction: builder.createMutator("POST", "/accounts/:accountId/actions/:actionId"),
  };
}
