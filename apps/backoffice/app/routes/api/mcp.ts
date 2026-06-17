import {
  handleBackofficeMcpOAuthCallback,
  isBackofficeMcpOAuthCallbackRequest,
} from "@/fragno/mcp-oauth-proxy";
import { getMcpDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/mcp";

type RouteContext = Route.LoaderArgs["context"];

const MCP_PUBLIC_PREFIX = "/api/mcp";

const forwardToMcp = async (request: Request, context: RouteContext, orgId: string | undefined) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  if (isBackofficeMcpOAuthCallbackRequest(request, orgId)) {
    return handleBackofficeMcpOAuthCallback(request, context, orgId);
  }

  const mcpDo = getMcpDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `${MCP_PUBLIC_PREFIX}/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `${MCP_PUBLIC_PREFIX}${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  return mcpDo.fetch(new Request(url.toString(), request));
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToMcp(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToMcp(request, context, params.orgId);
}
