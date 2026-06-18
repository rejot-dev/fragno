import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { apiFragmentDefinition, type ApiFragmentConfig } from "./definition";
import { apiRoutesFactory } from "./routes";

const routes = [apiRoutesFactory] as const;

export function createApiFragment(
  config: ApiFragmentConfig,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(apiFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createApiFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(apiFragmentDefinition, fragnoConfig, routes);

  return {
    useConnections: builder.createHook("/connections"),
    useConnection: builder.createHook("/connections/:slug"),
    useAuthStatus: builder.createHook("/connections/:slug/auth/status"),
    createConnection: builder.createMutator("PUT", "/connections/:slug"),
    deleteConnection: builder.createMutator("DELETE", "/connections/:slug"),
    setBearerToken: builder.createMutator("POST", "/connections/:slug/auth/token"),
    startOAuth: builder.createMutator("POST", "/connections/:slug/auth/oauth/start"),
    deleteAuth: builder.createMutator("DELETE", "/connections/:slug/auth"),
    request: builder.createMutator("POST", "/connections/:slug/request"),
  };
}

export { apiFragmentDefinition } from "./definition";
export { apiRoutesFactory } from "./routes";
export { apiSchema } from "./schema";
export type { ApiFragmentConfig } from "./definition";
export type { ApiConnection, ApiConnectionInput, ApiRequestInput, AuthConfig } from "./api-types";
