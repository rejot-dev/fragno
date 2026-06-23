import { backofficeScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import {
  handleBackofficeMcpOAuthCallback,
  isBackofficeMcpOAuthCallbackRequest,
} from "@/fragno/mcp-oauth-proxy";
import { getMcpObjectForScope } from "@/routes/backoffice/connections/mcp/data";

import type { Route } from "./+types/mcp";

type RouteContext = Route.LoaderArgs["context"];

const MCP_PUBLIC_PREFIX = "/api/mcp";

const forwardToMcp = async (
  request: Request,
  context: RouteContext,
  scopePathSegment: string | undefined,
) => {
  if (!scopePathSegment) {
    return new Response("Missing MCP scope", { status: 400 });
  }

  if (isBackofficeMcpOAuthCallbackRequest(request, scopePathSegment)) {
    return handleBackofficeMcpOAuthCallback(request, context, scopePathSegment);
  }

  let scope;
  try {
    scope = backofficeScopeFromSinglePathSegment(scopePathSegment);
  } catch {
    return new Response("Invalid MCP scope", { status: 400 });
  }

  const mcpDo = getMcpObjectForScope(context, scope);
  const url = new URL(request.url);
  const encodedScopeSegment = encodeURIComponent(scopePathSegment);
  const prefix = `${MCP_PUBLIC_PREFIX}/${encodedScopeSegment}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `${MCP_PUBLIC_PREFIX}${suffix}`;
  }
  url.searchParams.set("scopeKind", scope.kind);
  if (scope.kind === "org" || scope.kind === "project") {
    url.searchParams.set("orgId", scope.orgId);
  }
  if (scope.kind === "project") {
    url.searchParams.set("projectId", scope.projectId);
  }
  if (scope.kind === "user") {
    url.searchParams.set("userId", scope.userId);
  }

  return mcpDo.fetch(new Request(url.toString(), request));
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToMcp(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToMcp(request, context, params.orgId);
}
