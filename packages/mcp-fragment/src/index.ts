import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { mcpFragmentDefinition, type McpFragmentConfig } from "./definition";
import { mcpRoutesFactory } from "./routes";

const routes = [mcpRoutesFactory] as const;

export function createMcpFragment(
  config: McpFragmentConfig,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(mcpFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createMcpFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(mcpFragmentDefinition, fragnoConfig, routes);

  return {
    useServers: builder.createHook("/servers"),
    useServer: builder.createHook("/servers/:slug"),
    useTools: builder.createHook("/servers/:slug/tools"),
    createServer: builder.createMutator("POST", "/servers"),
    callTool: builder.createMutator("POST", "/servers/:slug/tools/execute"),
    setToken: builder.createMutator("POST", "/servers/:slug/auth/token"),
    startOAuth: builder.createMutator("POST", "/servers/:slug/auth/start"),
    deleteAuth: builder.createMutator("DELETE", "/servers/:slug/auth"),
  };
}
