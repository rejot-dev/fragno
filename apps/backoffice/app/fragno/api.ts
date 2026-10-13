import type { ApiFragmentConfig } from "@fragno-dev/api-fragment/definition";
import { createApiFragment } from "@fragno-dev/api-fragment/server";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";

export type ApiConfig = Pick<
  ApiFragmentConfig,
  | "allowedBaseUrls"
  | "allowedOAuthRedirectUris"
  | "fetch"
  | "onConnectionDeleted"
  | "onConnectionReadinessChanged"
  | "onWebhookEndpointChanged"
  | "onWebhookReceived"
>;

export function createApiServer(
  config: ApiConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
): ReturnType<typeof createApiFragment> {
  return createApiFragment(
    {
      allowedBaseUrls: config.allowedBaseUrls,
      allowedOAuthRedirectUris: config.allowedOAuthRedirectUris,
      fetch: config.fetch,
      onConnectionDeleted: config.onConnectionDeleted,
      onConnectionReadinessChanged: config.onConnectionReadinessChanged,
      onWebhookEndpointChanged: config.onWebhookEndpointChanged,
      onWebhookReceived: config.onWebhookReceived,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({
        kind: "api",
      }),
      mountRoute: "/api/api",
    },
  ).withMiddleware(async function authorizeApiRoutes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    // OAuth state and webhook credentials remain the fragment's responsibility.
    await ifMatchesRoute("GET", "/oauth/callback", () => {
      access = "public-ingress";
    });
    await ifMatchesRoute("GET", "/webhooks/endpoints/:endpointId/events", () => {
      access = "public-ingress";
    });
    await ifMatchesRoute("POST", "/webhooks/endpoints/:endpointId/events", () => {
      access = "public-ingress";
    });

    await ifMatchesRoute("GET", "/connections", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("GET", "/connections/:slug", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("PUT", "/connections/:slug", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    // Replacement writes connection and auth state, which creation authority governs.
    await ifMatchesRoute("PUT", "/connections/:slug/configuration", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("DELETE", "/connections/:slug", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("GET", "/connections/:slug/auth/status", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("POST", "/connections/:slug/auth/token", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    // A pending link embeds the callback state, so only setup authority may resume it.
    await ifMatchesRoute("GET", "/connections/:slug/auth/oauth/pending", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("POST", "/connections/:slug/auth/oauth/start", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("DELETE", "/connections/:slug/auth", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("POST", "/connections/:slug/request", () => {
      access = BACKOFFICE_PERMISSION.integrations.execute;
    });

    await ifMatchesRoute("GET", "/webhooks/endpoints", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("GET", "/webhooks/endpoints/:endpointId", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("PUT", "/webhooks/endpoints/:endpointId", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("PATCH", "/webhooks/endpoints/:endpointId", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("DELETE", "/webhooks/endpoints/:endpointId", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type ApiFragment = ReturnType<typeof createApiServer>;
