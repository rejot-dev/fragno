import { MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER } from "@fragno-dev/mcp-fragment/types";

import { forwardPublicFragmentRequest } from "@/fragno/public-fragment-route.server";
import { mcpPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/mcp-oauth-start";
import { mcpPublicRoute } from "./mcp-route.server";

export async function action({ request, context, params }: Route.ActionArgs) {
  const url = new URL(request.url);
  url.searchParams.set(
    MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
    mcpPublicAddress(
      context.get(BackofficeWorkerContext).runtime.config.docsPublicBaseUrl,
      params.scopeSegment,
    ).oauthRedirectUri,
  );
  return forwardPublicFragmentRequest({
    request: new Request(url, request),
    context,
    scopePathSegment: params.scopeSegment,
    route: mcpPublicRoute,
  });
}
