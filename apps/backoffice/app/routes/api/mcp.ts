import type { McpObject } from "@/backoffice-runtime/object-registry";
import { backofficeScopeRouteId } from "@/backoffice-runtime/scope-codec";
import {
  forwardScopedPublicRequest,
  type ScopedPublicFragmentProxy,
} from "@/fragno/scoped-public-fragment-proxy";
import {
  MCP_INTERNAL_OAUTH_CALLBACK_PATH,
  MCP_INTERNAL_PREFIX,
  MCP_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/mcp";

const mcpPublicProxy = {
  publicPrefix: MCP_PUBLIC_PREFIX,
  internalPrefix: MCP_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.mcp.for(scope),
  oauth: {
    internalCallbackPath: MCP_INTERNAL_OAUTH_CALLBACK_PATH,
    invalidResponse: (message) => new Response(message, { status: 502 }),
    redirect: ({ request, scope, status }) => {
      const redirectUrl = new URL(
        `/backoffice/automations/${scope.kind}/${encodeURIComponent(backofficeScopeRouteId(scope))}/mcp`,
        request.url,
      );
      redirectUrl.searchParams.set("oauth", status);

      const serverSlug = new URL(request.url).searchParams.get("state")?.split(":")[0]?.trim();
      if (serverSlug) {
        redirectUrl.searchParams.set("server", serverSlug);
      }

      return Response.redirect(redirectUrl, 302);
    },
  },
} satisfies ScopedPublicFragmentProxy<McpObject>;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardScopedPublicRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    proxy: mcpPublicProxy,
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardScopedPublicRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    proxy: mcpPublicProxy,
  });
}
