import type { McpFragmentConfig } from "@fragno-dev/mcp-fragment/definition";

import { createMcpFragment } from "@fragno-dev/mcp-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

export type McpConfig = Pick<
  McpFragmentConfig,
  "allowedOAuthRedirectUris" | "onServerConfigurationChanged" | "onServerConfigurationDeleted"
>;

export function createMcpServer(
  config: McpConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
): ReturnType<typeof createMcpFragment> {
  return createMcpFragment(
    {
      allowedOAuthRedirectUris: config.allowedOAuthRedirectUris,
      onServerConfigurationChanged: config.onServerConfigurationChanged,
      onServerConfigurationDeleted: config.onServerConfigurationDeleted,
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
      access = BACKOFFICE_PERMISSION.mcp.serversCreate;
    });
    await ifMatchesRoute("GET", "/servers", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversRead;
    });
    await ifMatchesRoute("GET", "/servers/:slug", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversRead;
    });
    await ifMatchesRoute("DELETE", "/servers/:slug", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversDelete;
    });
    await ifMatchesRoute("GET", "/servers/:slug/auth/status", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversRead;
    });
    await ifMatchesRoute("POST", "/servers/:slug/auth/token", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversCreate;
    });
    await ifMatchesRoute("POST", "/servers/:slug/auth/start", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversCreate;
    });
    await ifMatchesRoute("DELETE", "/servers/:slug/auth", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversDelete;
    });
    await ifMatchesRoute("POST", "/servers/:slug/refresh", () => {
      access = BACKOFFICE_PERMISSION.mcp.serversRead;
    });
    await ifMatchesRoute("POST", "/servers/:slug/tools/execute", () => {
      access = BACKOFFICE_PERMISSION.mcp.toolsCall;
    });
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type McpFragment = ReturnType<typeof createMcpServer>;
