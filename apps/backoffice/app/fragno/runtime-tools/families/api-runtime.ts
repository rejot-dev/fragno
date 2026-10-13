import {
  type UpdateWebhookEndpointInput,
  type WebhookEndpoint,
  type WebhookEndpointInput,
} from "@fragno-dev/api-fragment/types";
import type {
  webhookEndpointSchema,
  webhookEndpointsOutputSchema,
} from "@fragno-dev/backoffice-api/v0/http-api";
import { createRouteCaller } from "@fragno-dev/core/api";
import type { z } from "zod";

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
import type { ApiWebhookEndpointInput, ApiWebhookEndpointUpdateInput } from "./api";

// The runtime returns the fragment's records; tool output parsing turns their dates into ISO strings.
type ApiWebhookEndpointResult = z.input<typeof webhookEndpointSchema>;
type ApiWebhookEndpointsResult = z.input<typeof webhookEndpointsOutputSchema>;

export type ApiRuntime = {
  listWebhookEndpoints: () => Promise<ApiWebhookEndpointsResult>;
  getWebhookEndpoint: (input: { endpointId: string }) => Promise<ApiWebhookEndpointResult>;
  createWebhookEndpoint: (
    input: { endpointId: string } & ApiWebhookEndpointInput,
  ) => Promise<ApiWebhookEndpointResult>;
  updateWebhookEndpoint: (
    input: { endpointId: string } & ApiWebhookEndpointUpdateInput,
  ) => Promise<ApiWebhookEndpointResult>;
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
): ApiWebhookEndpointResult => ({
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
