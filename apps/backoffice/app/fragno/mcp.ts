import type { McpFragmentConfig } from "@fragno-dev/mcp-fragment/definition";

import { createMcpFragment } from "@fragno-dev/mcp-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export type McpConfig = Pick<
  McpFragmentConfig,
  "publicBaseUrl" | "onServerConfigurationChanged" | "onServerConfigurationDeleted"
>;

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
