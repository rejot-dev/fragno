import {
  API_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
  type ApiConnectionInput,
  type ApiRequestInput,
  type UpdateWebhookEndpointInput,
  type WebhookEndpoint,
  type WebhookEndpointInput,
} from "@fragno-dev/api-fragment/types";
import { createRouteCaller } from "@fragno-dev/core/api";

import type { FetchObject } from "@/backoffice-runtime/object-registry";
import type { ApiFragment } from "@/fragno/api";
import {
  apiWebhookPublicUrl,
  type ScopedPublicFragmentAddress,
} from "@/fragno/scoped-public-fragment-routes";

import {
  createOrganizationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";
import type {
  ApiAuthStatus,
  ApiConnection,
  ApiListConnectionsOutput,
  ApiOAuthStartInput,
  ApiOAuthStartOutput,
  ApiRequestOutput,
  ApiSetTokenInput,
  ApiWebhookEndpoint,
  ApiWebhookEndpointInput,
  ApiWebhookEndpointsOutput,
  ApiWebhookEndpointUpdateInput,
} from "./api";

export type ApiRuntime = {
  listConnections: () => Promise<ApiListConnectionsOutput>;
  createConnection: (input: { slug: string } & ApiConnectionInput) => Promise<ApiConnection>;
  deleteConnection: (input: { slug: string }) => Promise<{ ok: true }>;
  getAuthStatus: (input: { slug: string }) => Promise<ApiAuthStatus>;
  setToken: (input: { slug: string } & ApiSetTokenInput) => Promise<ApiAuthStatus>;
  startOAuth: (input: { slug: string } & ApiOAuthStartInput) => Promise<ApiOAuthStartOutput>;
  deleteAuth: (input: { slug: string }) => Promise<{ ok: true }>;
  request: (input: { slug: string } & ApiRequestInput) => Promise<ApiRequestOutput>;
  listWebhookEndpoints: () => Promise<ApiWebhookEndpointsOutput>;
  getWebhookEndpoint: (input: { endpointId: string }) => Promise<ApiWebhookEndpoint>;
  createWebhookEndpoint: (
    input: { endpointId: string } & ApiWebhookEndpointInput,
  ) => Promise<ApiWebhookEndpoint>;
  updateWebhookEndpoint: (
    input: { endpointId: string } & ApiWebhookEndpointUpdateInput,
  ) => Promise<ApiWebhookEndpoint>;
  deleteWebhookEndpoint: (input: { endpointId: string }) => Promise<{ ok: true }>;
};

export type RegisteredApiCommandContext = {
  runtime: ApiRuntime;
};

const API_NOT_CONFIGURED = createOrganizationNotConfiguredMessage("API");

type CreateRouteBackedApiRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch: (request: Request) => Promise<Response>;
};

const createApiRouteCaller = (options: CreateRouteBackedApiRuntimeOptions) =>
  createRouteCaller<ApiFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/api",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });

const appendWebhookPublicUrl = (
  endpoint: WebhookEndpoint,
  publicBaseUrl: string,
): ApiWebhookEndpoint => ({
  ...endpoint,
  publicUrl: apiWebhookPublicUrl(publicBaseUrl, endpoint.id),
});

const normalizeSlug = (slug: string, label = "API connection slug") => {
  const normalized = slug.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
};

const throwOnApiRuntimeError = (
  response: Awaited<ReturnType<ReturnType<typeof createApiRouteCaller>>>,
  label: string,
) =>
  throwOnRouteRuntimeError(response, {
    runtimeLabel: "API fragment",
    label,
    notConfiguredMessage: API_NOT_CONFIGURED,
  });

export const createRouteBackedApiRuntime = (
  options: CreateRouteBackedApiRuntimeOptions & {
    resolvePublicAddress: () => Promise<ScopedPublicFragmentAddress>;
  },
): ApiRuntime => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("API runtime requires a base URL");
  }

  const callRoute = createApiRouteCaller({ ...options, baseUrl });

  return {
    listConnections: async () => {
      const response = await callRoute("GET", "/connections");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as ApiListConnectionsOutput;
      }
      return throwOnApiRuntimeError(response, "api.connections.list");
    },
    createConnection: async ({ slug, ...body }) => {
      const response = await callRoute("PUT", "/connections/:slug", {
        pathParams: { slug: normalizeSlug(slug) },
        body,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as ApiConnection;
      }
      return throwOnApiRuntimeError(response, "api.connections.create");
    },
    deleteConnection: async ({ slug }) => {
      const response = await callRoute("DELETE", "/connections/:slug", {
        pathParams: { slug: normalizeSlug(slug) },
      });
      if (isSuccessStatus(response.status)) {
        return { ok: true };
      }
      return throwOnApiRuntimeError(response, "api.connections.delete");
    },
    getAuthStatus: async ({ slug }) => {
      const response = await callRoute("GET", "/connections/:slug/auth/status", {
        pathParams: { slug: normalizeSlug(slug) },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as ApiAuthStatus;
      }
      return throwOnApiRuntimeError(response, "api.auth.status");
    },
    setToken: async ({ slug, token }) => {
      const response = await callRoute("POST", "/connections/:slug/auth/token", {
        pathParams: { slug: normalizeSlug(slug) },
        body: { token },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as ApiAuthStatus;
      }
      return throwOnApiRuntimeError(response, "api.auth.token");
    },
    startOAuth: async ({ slug, scopes, extraAuthorizationParams }) => {
      const publicAddress = await options.resolvePublicAddress();
      const response = await callRoute("POST", "/connections/:slug/auth/oauth/start", {
        pathParams: { slug: normalizeSlug(slug) },
        query: {
          [API_OAUTH_REDIRECT_URI_QUERY_PARAMETER]: publicAddress.oauthRedirectUri,
        },
        body: {
          ...(scopes?.length ? { scopes } : {}),
          ...(extraAuthorizationParams ? { extraAuthorizationParams } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as ApiOAuthStartOutput;
      }
      return throwOnApiRuntimeError(response, "api.oauth.start");
    },
    deleteAuth: async ({ slug }) => {
      const response = await callRoute("DELETE", "/connections/:slug/auth", {
        pathParams: { slug: normalizeSlug(slug) },
      });
      if (isSuccessStatus(response.status)) {
        return { ok: true };
      }
      return throwOnApiRuntimeError(response, "api.auth.delete");
    },
    request: async ({ slug, ...body }) => {
      const response = await callRoute("POST", "/connections/:slug/request", {
        pathParams: { slug: normalizeSlug(slug) },
        body,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as ApiRequestOutput;
      }
      return throwOnApiRuntimeError(response, "api.request");
    },
    listWebhookEndpoints: async () => {
      const response = await callRoute("GET", "/webhooks/endpoints");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        const publicAddress = await options.resolvePublicAddress();
        const data = response.data;
        return {
          endpoints: data.endpoints.map((endpoint) =>
            appendWebhookPublicUrl(endpoint, publicAddress.baseUrl),
          ),
        };
      }
      return throwOnApiRuntimeError(response, "api.webhooks.list");
    },
    getWebhookEndpoint: async ({ endpointId }) => {
      const response = await callRoute("GET", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: normalizeSlug(endpointId, "Webhook endpoint id") },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return appendWebhookPublicUrl(
          response.data,
          (await options.resolvePublicAddress()).baseUrl,
        );
      }
      return throwOnApiRuntimeError(response, "api.webhooks.get");
    },
    createWebhookEndpoint: async ({ endpointId, ...body }) => {
      const response = await callRoute("PUT", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: normalizeSlug(endpointId, "Webhook endpoint id") },
        body: body satisfies WebhookEndpointInput,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return appendWebhookPublicUrl(
          response.data,
          (await options.resolvePublicAddress()).baseUrl,
        );
      }
      return throwOnApiRuntimeError(response, "api.webhooks.create");
    },
    updateWebhookEndpoint: async ({ endpointId, ...body }) => {
      const response = await callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: normalizeSlug(endpointId, "Webhook endpoint id") },
        body: body satisfies UpdateWebhookEndpointInput,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return appendWebhookPublicUrl(
          response.data,
          (await options.resolvePublicAddress()).baseUrl,
        );
      }
      return throwOnApiRuntimeError(response, "api.webhooks.update");
    },
    deleteWebhookEndpoint: async ({ endpointId }) => {
      const response = await callRoute("DELETE", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: normalizeSlug(endpointId, "Webhook endpoint id") },
      });
      if (isSuccessStatus(response.status)) {
        return { ok: true };
      }
      return throwOnApiRuntimeError(response, "api.webhooks.delete");
    },
  };
};

export const createApiRuntime = (
  object: FetchObject,
  resolvePublicAddress: () => Promise<ScopedPublicFragmentAddress>,
) => {
  let publicAddress: Promise<ScopedPublicFragmentAddress> | null = null;
  return createRouteBackedApiRuntime({
    baseUrl: "https://api.do",
    fetch: (outboundRequest) => object.fetch(outboundRequest),
    resolvePublicAddress: () => (publicAddress ??= resolvePublicAddress()),
  });
};

export const createUnavailableApiRuntime = (message = API_NOT_CONFIGURED): ApiRuntime => ({
  listConnections: async () => {
    throw new Error(message);
  },
  createConnection: async () => {
    throw new Error(message);
  },
  deleteConnection: async () => {
    throw new Error(message);
  },
  getAuthStatus: async () => {
    throw new Error(message);
  },
  setToken: async () => {
    throw new Error(message);
  },
  startOAuth: async () => {
    throw new Error(message);
  },
  deleteAuth: async () => {
    throw new Error(message);
  },
  request: async () => {
    throw new Error(message);
  },
  listWebhookEndpoints: async () => {
    throw new Error(message);
  },
  getWebhookEndpoint: async () => {
    throw new Error(message);
  },
  createWebhookEndpoint: async () => {
    throw new Error(message);
  },
  updateWebhookEndpoint: async () => {
    throw new Error(message);
  },
  deleteWebhookEndpoint: async () => {
    throw new Error(message);
  },
});
