import type { McpFragmentConfig } from "@fragno-dev/mcp-fragment/definition";

import { createMcpFragment } from "@fragno-dev/mcp-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export type McpConfig = Pick<
  McpFragmentConfig,
  "publicBaseUrl" | "onServerConfigurationChanged" | "onServerConfigurationDeleted"
>;

export const resolveMcpPublicBaseUrl = ({ baseUrl, orgId }: { baseUrl: string; orgId: string }) => {
  const parsed = new URL(baseUrl);
  const mountPath = `/api/mcp/${orgId}`;
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath !== mountPath) {
    parsed.pathname = `${trimmedPath}${mountPath}`.replace(/\/+/g, "/");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

export function createMcpServer(
  config: McpConfig,
  runtime: BackofficeFragmentRuntimeOptions,
): ReturnType<typeof createMcpFragment> {
  return createMcpFragment(
    {
      publicBaseUrl: config.publicBaseUrl,
      onServerConfigurationChanged: config.onServerConfigurationChanged,
      onServerConfigurationDeleted: config.onServerConfigurationDeleted,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({
        kind: "mcp",
      }),
      mountRoute: "/api/mcp",
    },
  );
}

export type McpFragment = ReturnType<typeof createMcpServer>;
