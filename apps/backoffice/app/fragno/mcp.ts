import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { McpFragmentConfig } from "@fragno-dev/mcp-fragment/definition";

import { createMcpFragment } from "@fragno-dev/mcp-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";

export type McpConfig = Pick<
  McpFragmentConfig,
  | "allowedOAuthRedirectUris"
  | "fetch"
  | "onServerConfigurationChanged"
  | "onServerConfigurationDeleted"
  | "onServerReadinessChanged"
>;

export function createMcpServer(
  config: McpConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
): ReturnType<typeof createMcpFragment> {
  return createMcpFragment(
    {
      allowedOAuthRedirectUris: config.allowedOAuthRedirectUris,
      fetch: config.fetch,
      onServerConfigurationChanged: config.onServerConfigurationChanged,
      onServerConfigurationDeleted: config.onServerConfigurationDeleted,
      onServerReadinessChanged: config.onServerReadinessChanged,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({
        kind: "mcp",
      }),
      mountRoute: "/api/mcp",
    },
  ).withMiddleware(async function authorizeMcpRoutes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    await ifMatchesRoute("GET", "/oauth/callback", () => {
      access = "public-ingress";
    });
    await ifMatchesRoute("POST", "/servers", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("GET", "/servers", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("GET", "/servers/:slug", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("PUT", "/servers/:slug/configuration", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("DELETE", "/servers/:slug", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("GET", "/servers/:slug/auth/status", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("POST", "/servers/:slug/auth/token", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    // A pending link embeds the callback state, so only setup authority may resume it.
    await ifMatchesRoute("GET", "/servers/:slug/auth/pending", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("POST", "/servers/:slug/auth/start", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("DELETE", "/servers/:slug/auth", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("POST", "/servers/:slug/refresh", () => {
      access = BACKOFFICE_PERMISSION.connections.read;
    });
    await ifMatchesRoute("POST", "/servers/:slug/tools/execute", () => {
      access = BACKOFFICE_PERMISSION.integrations.execute;
    });
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type McpFragment = ReturnType<typeof createMcpServer>;
