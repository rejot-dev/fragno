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

/** Discover project OAuth configurations and select only server-verified accounts for actions. */
export function createProjectConnectorFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(projectConnectorFragmentDefinition, fragnoConfig, routes);
  return {
    useProviderConfigs: builder.createHook("/provider-configs"),
    useProviderActions: builder.createHook("/provider-configs/:providerConfigId/actions"),
    useStatus: builder.createHook("/status"),
    useAccounts: builder.createHook("/accounts"),
    useNamedAccount: builder.createHook("/accounts/by-name"),
    useNamedConnectionRequest: builder.createHook("/connection-requests/by-name"),
    useProfile: builder.createHook("/accounts/:accountId/profile"),
    connect: builder.createMutator("POST", "/connection-requests", (invalidate) => {
      invalidate("GET", "/connection-requests/by-name", {});
    }),
    refreshConnection: builder.createMutator(
      "POST",
      "/connection-requests/:requestId/refresh",
      (invalidate) => {
        invalidate("GET", "/accounts", {});
        invalidate("GET", "/accounts/by-name", {});
        invalidate("GET", "/connection-requests/by-name", {});
      },
    ),
    executeAction: builder.createMutator("POST", "/accounts/:accountId/actions/:actionId"),
  };
}
