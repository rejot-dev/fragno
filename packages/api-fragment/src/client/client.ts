import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { apiFragmentDefinition } from "../definition";
import { apiRoutesFactory } from "../routes";

const apiRoutes = [apiRoutesFactory] as const;

export function createApiFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(apiFragmentDefinition, fragnoConfig, apiRoutes);

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
    useWebhookEndpoints: builder.createHook("/webhooks/endpoints"),
    useWebhookEndpoint: builder.createHook("/webhooks/endpoints/:endpointId"),
    createWebhookEndpoint: builder.createMutator("PUT", "/webhooks/endpoints/:endpointId"),
    updateWebhookEndpoint: builder.createMutator("PATCH", "/webhooks/endpoints/:endpointId"),
    deleteWebhookEndpoint: builder.createMutator("DELETE", "/webhooks/endpoints/:endpointId"),
  };
}
