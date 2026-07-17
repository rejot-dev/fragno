import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  isBackofficeRoutableScope,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import type { McpFragment } from "@/fragno/mcp";
import { getMcpDurableObject } from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { McpConfigState } from "./shared";

export type McpServerCache = {
  protocolVersion?: string | null;
  serverInfo?: unknown;
  capabilities?: unknown;
  tools?: McpToolSummary[] | null;
  updatedAt?: string | Date;
};

export type McpServerSummary = {
  slug: string;
  name?: string | null;
  endpointUrl: string;
  authMode: string;
  cache?: McpServerCache | null;
};

export type McpToolSummary = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type McpServerToolsState = {
  slug: string;
  tools: McpToolSummary[];
  error?: string;
};

export type McpServerRefresh = {
  ok: boolean;
  tools: McpToolSummary[];
  stage: "auth" | "list_tools" | null;
  checkedAt: string;
  server: Omit<McpServerSummary, "cache">;
  auth: {
    authenticated: boolean;
    mode: string;
    tokenPresent: boolean;
    expiresAt: string | Date | null;
    expired: boolean | null;
    scopes: {
      requested: string[] | null;
      granted: string[] | null;
      missing: string[] | null;
      raw: string | null;
    };
  };
  live: {
    reachable: boolean;
    listToolsOk: boolean;
    toolCount: number | null;
    protocolVersion: string | null;
    serverInfo: unknown;
    capabilities: unknown;
  };
  cache: {
    presentBeforeCheck: boolean;
    previousToolCount: number | null;
    updatedToolCount: number | null;
  };
  error: { code: string; message: string } | null;
};

export type McpServerRefreshState = {
  slug: string;
  refresh: McpServerRefresh;
};

const routeResponseMessage = (response: {
  type: string;
  status: number;
  error?: { message: string };
  data?: unknown;
}) => {
  if (response.type === "json") {
    return JSON.stringify(response.data);
  }
  if (response.type === "error") {
    return response.error?.message ?? `Request failed with status ${response.status}.`;
  }
  return `Request failed with status ${response.status}.`;
};

export const requireMcpOwnerScope = (scope: BackofficeContextScope): BackofficeRoutableScope => {
  if (!isBackofficeRoutableScope(scope)) {
    throw new Error(`MCP is not available in ${scope.kind} scope.`);
  }
  return scope;
};

export const getMcpObjectForScope = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  return kernel.scoped("MCP", requireMcpOwnerScope(scope), runtime.objects.mcp);
};

const createMcpRouteCallerForScope = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const mcpDo = getMcpObjectForScope(context, scope);
  return createRouteCaller<McpFragment>({
    baseUrl: new URL(request.url).origin,
    mountRoute: "/api/mcp",
    fetch: async (outboundRequest) => mcpDo.fetch(outboundRequest),
  });
};

const createMcpRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => createMcpRouteCallerForScope(request, context, { kind: "org", orgId });

export async function ensureMcpConfiguredForScope(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) {
  const ownerScope = requireMcpOwnerScope(scope);
  const mcpDo = getMcpObjectForScope(context, ownerScope);
  const status = await mcpDo.getAdminConfig();
  if (!status.configured) {
    await mcpDo.setAdminConfig({ scope: ownerScope });
  }
}

export async function fetchMcpConfigForScope(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<{ configState: McpConfigState | null; configError: string | null }> {
  try {
    const mcpDo = getMcpObjectForScope(context, scope);
    return { configState: await mcpDo.getAdminConfig(), configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Unable to load MCP configuration.",
    };
  }
}

export async function fetchMcpConfig(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{ configState: McpConfigState | null; configError: string | null }> {
  try {
    const mcpDo = getMcpDurableObject(context, orgId);
    return { configState: await mcpDo.getAdminConfig(), configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Unable to load MCP configuration.",
    };
  }
}

export async function fetchMcpServersForScope(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<{ servers: McpServerSummary[]; serversError: string | null }> {
  try {
    const callRoute = createMcpRouteCallerForScope(request, context, scope);
    const response = await callRoute("GET", "/servers");
    if (response.type === "json" && response.status >= 200 && response.status < 300) {
      return { servers: response.data.servers as McpServerSummary[], serversError: null };
    }
    const message = routeResponseMessage(response);
    return { servers: [], serversError: message || "Unable to load MCP servers." };
  } catch (error) {
    return {
      servers: [],
      serversError: error instanceof Error ? error.message : "Unable to load MCP servers.",
    };
  }
}

export async function fetchMcpServers(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{ servers: McpServerSummary[]; serversError: string | null }> {
  return fetchMcpServersForScope(request, context, { kind: "org", orgId });
}

export function createMcpActionRouteCallerForScope(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): RouteCallerForFragment<McpFragment> {
  return createMcpRouteCallerForScope(request, context, scope);
}

export function createMcpActionRouteCaller(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): RouteCallerForFragment<McpFragment> {
  return createMcpRouteCaller(request, context, orgId);
}
