import { createRouteCaller } from "@fragno-dev/core/api";
import type { CreateServerInput, McpTool, ToolCallInput } from "@fragno-dev/mcp-fragment/types";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { McpFragment } from "@/fragno/mcp";

import {
  createOrganisationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";
import type {
  McpAuthStatus,
  McpCreateServerOutput,
  McpListServersOutput,
  McpListToolsOutput,
  McpOAuthStartInput,
  McpOAuthStartOutput,
  McpSetTokenInput,
  McpToolCallOutput,
} from "./mcp";

export type McpRuntime = {
  listServers: () => Promise<McpListServersOutput>;
  createServer: (input: CreateServerInput) => Promise<McpCreateServerOutput>;
  deleteServer: (input: { slug: string }) => Promise<{ ok: true }>;
  listTools: (input: { slug: string }) => Promise<McpListToolsOutput>;
  callTool: (input: { slug: string } & ToolCallInput) => Promise<McpToolCallOutput>;
  startOAuth: (input: { slug: string } & McpOAuthStartInput) => Promise<McpOAuthStartOutput>;
  setToken: (input: { slug: string } & McpSetTokenInput) => Promise<McpAuthStatus>;
  getAuthStatus: (input: { slug: string }) => Promise<McpAuthStatus>;
};

export type RegisteredMcpCommandContext = {
  runtime: McpRuntime;
};

const MCP_NOT_CONFIGURED = createOrganisationNotConfiguredMessage("MCP");

type CreateRouteBackedMcpRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

const createMcpRouteCaller = (options: CreateRouteBackedMcpRuntimeOptions) =>
  createRouteCaller<McpFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/mcp",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });

const normalizeSlug = (slug: string, label = "MCP server slug") => {
  const normalized = slug.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
};

const throwOnMcpRuntimeError = (
  response: Awaited<ReturnType<ReturnType<typeof createMcpRouteCaller>>>,
  label: string,
) =>
  throwOnRouteRuntimeError(response, {
    runtimeLabel: "MCP fragment",
    label,
    notConfiguredMessage: MCP_NOT_CONFIGURED,
  });

export const createRouteBackedMcpRuntime = (
  options: CreateRouteBackedMcpRuntimeOptions,
): McpRuntime => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("MCP runtime requires a base URL");
  }

  const callRoute = createMcpRouteCaller({ ...options, baseUrl });

  return {
    listServers: async () => {
      const response = await callRoute("GET", "/servers");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpListServersOutput;
      }
      return throwOnMcpRuntimeError(response, "mcp.servers.list");
    },
    createServer: async (input) => {
      const response = await callRoute("POST", "/servers", { body: input });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpCreateServerOutput;
      }
      return throwOnMcpRuntimeError(response, "mcp.servers.add");
    },
    deleteServer: async ({ slug }) => {
      const response = await callRoute("DELETE", "/servers/:slug", {
        pathParams: { slug: normalizeSlug(slug) },
      });
      if (isSuccessStatus(response.status)) {
        return { ok: true };
      }
      return throwOnMcpRuntimeError(response, "mcp.servers.delete");
    },
    listTools: async ({ slug }) => {
      const response = await callRoute("GET", "/servers/:slug/tools", {
        pathParams: { slug: normalizeSlug(slug) },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as { tools: McpTool[] };
      }
      return throwOnMcpRuntimeError(response, "mcp.servers.refresh");
    },
    callTool: async ({ slug, name, arguments: toolArguments, timeoutMs }) => {
      const response = await callRoute("POST", "/servers/:slug/tools/execute", {
        pathParams: { slug: normalizeSlug(slug) },
        body: {
          name,
          ...(toolArguments ? { arguments: toolArguments } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpToolCallOutput;
      }
      return throwOnMcpRuntimeError(response, "mcp.tools.call");
    },
    startOAuth: async ({ slug, scope, clientId, clientSecret }) => {
      const response = await callRoute("POST", "/servers/:slug/auth/start", {
        pathParams: { slug: normalizeSlug(slug) },
        body: {
          ...(scope ? { scope } : {}),
          ...(clientId ? { clientId } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpOAuthStartOutput;
      }
      return throwOnMcpRuntimeError(response, "mcp.oauth.start");
    },
    setToken: async ({ slug, token }) => {
      const response = await callRoute("POST", "/servers/:slug/auth/token", {
        pathParams: { slug: normalizeSlug(slug) },
        body: { token },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpAuthStatus;
      }
      return throwOnMcpRuntimeError(response, "mcp.auth.token");
    },
    getAuthStatus: async ({ slug }) => {
      const response = await callRoute("GET", "/servers/:slug/auth/status", {
        pathParams: { slug: normalizeSlug(slug) },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as McpAuthStatus;
      }
      return throwOnMcpRuntimeError(response, "mcp.auth.status");
    },
  };
};

export const createMcpRuntime = ({
  objects,
  orgId,
}: {
  objects: BackofficeObjectRegistry;
  orgId: string;
}) => {
  const mcpDo = objects.mcp.forOrg(orgId);
  return createRouteBackedMcpRuntime({
    baseUrl: "https://mcp.do",
    fetch: async (outboundRequest) => mcpDo.fetch(outboundRequest),
  });
};

export const createUnavailableMcpRuntime = (message = MCP_NOT_CONFIGURED): McpRuntime => ({
  listServers: async () => {
    throw new Error(message);
  },
  createServer: async () => {
    throw new Error(message);
  },
  deleteServer: async () => {
    throw new Error(message);
  },
  listTools: async () => {
    throw new Error(message);
  },
  callTool: async () => {
    throw new Error(message);
  },
  startOAuth: async () => {
    throw new Error(message);
  },
  setToken: async () => {
    throw new Error(message);
  },
  getAuthStatus: async () => {
    throw new Error(message);
  },
});
