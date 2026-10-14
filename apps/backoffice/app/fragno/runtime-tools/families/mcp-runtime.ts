import { createRouteCaller } from "@fragno-dev/core/api";
import type { McpTool, ToolCallInput } from "@fragno-dev/mcp-fragment/types";

import type { FetchObject } from "@/backoffice-runtime/object-registry";
import type { McpFragment } from "@/fragno/mcp";

import {
  createOrganizationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

export type McpListServersOutput = {
  servers: { slug: string; cache?: { tools?: McpTool[] | null } | null }[];
};

/** Lists servers and calls their tools for the generated codemode providers. */
export type McpRuntime = {
  listServers: () => Promise<McpListServersOutput>;
  callTool: (input: { slug: string } & ToolCallInput) => Promise<Record<string, unknown>>;
};

const MCP_NOT_CONFIGURED = createOrganizationNotConfiguredMessage("MCP");

export const createMcpRuntime = (object: FetchObject): McpRuntime => {
  const callRoute = createRouteCaller<McpFragment>({
    baseUrl: "https://mcp.do",
    mountRoute: "/api/mcp",
    fetch: (outboundRequest) => object.fetch(outboundRequest),
  });
  const fail = (response: Awaited<ReturnType<typeof callRoute>>, label: string) =>
    throwOnRouteRuntimeError(response, {
      runtimeLabel: "MCP fragment",
      label,
      notConfiguredMessage: MCP_NOT_CONFIGURED,
    });

  return {
    listServers: async () => {
      const response = await callRoute("GET", "/servers");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpListServersOutput;
      }
      return fail(response, "mcp.servers.list");
    },
    callTool: async ({ slug, name, arguments: toolArguments, timeoutMs }) => {
      const response = await callRoute("POST", "/servers/:slug/tools/execute", {
        pathParams: { slug },
        body: {
          name,
          ...(toolArguments ? { arguments: toolArguments } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "mcp.tools.call");
    },
  };
};
