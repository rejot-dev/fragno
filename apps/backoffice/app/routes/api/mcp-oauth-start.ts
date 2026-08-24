import { MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER } from "@fragno-dev/mcp-fragment/types";

import type { McpObject } from "@/backoffice-runtime/object-registry";
import {
  forwardPublicFragmentRequest,
  type PublicFragmentRoute,
} from "@/fragno/public-fragment-route.server";
import { mcpPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/mcp-oauth-start";
import { mcpPublicRoute } from "./mcp-route.server";

const mcpOAuthStartPublicRoute = {
  ...mcpPublicRoute,
  forwardRequest: function forwardMcpOAuthStart({ context, object, request, scopePathSegment }) {
    const internalUrl = new URL(request.url);
    internalUrl.searchParams.set(
      MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
      mcpPublicAddress(
        context.get(BackofficeWorkerContext).runtime.config.docsPublicBaseUrl,
        scopePathSegment,
      ).oauthRedirectUri,
    );
    return object.fetch(new Request(internalUrl, request));
  },
} satisfies PublicFragmentRoute<McpObject>;

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: mcpOAuthStartPublicRoute,
  });
}
