import type { ApiConnectionInput, ApiRequestInput } from "@fragno-dev/api-fragment/types";
import { createRouteCaller } from "@fragno-dev/core/api";

import type { ApiObject } from "@/backoffice-runtime/object-registry";
import type { ApiFragment } from "@/fragno/api";

import {
  createOrganisationNotConfiguredMessage,
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
};

export type RegisteredApiCommandContext = {
  runtime: ApiRuntime;
};

const API_NOT_CONFIGURED = createOrganisationNotConfiguredMessage("API");

type CreateRouteBackedApiRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

const createApiRouteCaller = (options: CreateRouteBackedApiRuntimeOptions) =>
  createRouteCaller<ApiFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/api",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
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

const createRouteBackedApiRuntime = (options: CreateRouteBackedApiRuntimeOptions): ApiRuntime => {
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
      const response = await callRoute("POST", "/connections/:slug/auth/oauth/start", {
        pathParams: { slug: normalizeSlug(slug) },
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
  };
};

export const createApiRuntime = (object: ApiObject) =>
  createRouteBackedApiRuntime({
    baseUrl: "https://api.do",
    fetch: async (outboundRequest) => object.fetch(outboundRequest),
  });

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
});
