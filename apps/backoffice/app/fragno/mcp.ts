import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import type { McpFragmentConfig } from "@fragno-dev/mcp-fragment/types";

import { createMcpFragment } from "@fragno-dev/mcp-fragment";

export type McpConfig = Pick<McpFragmentConfig, "publicBaseUrl">;

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

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createMcpServer(
  config: McpConfig,
  state: DurableObjectState,
): ReturnType<typeof createMcpFragment> {
  return createMcpFragment(
    {
      publicBaseUrl: config.publicBaseUrl,
    },
    {
      databaseAdapter: createAdapter(state),
      mountRoute: "/api/mcp",
    },
  );
}

export type McpFragment = ReturnType<typeof createMcpServer>;
