import type { McpObject } from "@/backoffice-runtime/object-registry";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import {
  MCP_INTERNAL_OAUTH_CALLBACK_PATH,
  MCP_INTERNAL_PREFIX,
  MCP_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export const mcpPublicRoute = {
  publicPrefix: MCP_PUBLIC_PREFIX,
  internalPrefix: MCP_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.mcp.for(scope),
  forwardRequest: ({ object, request }) => object.http.fetch(request),
  oauth: {
    internalCallbackPath: MCP_INTERNAL_OAUTH_CALLBACK_PATH,
    invalidResponse: (message) => new Response(message, { status: 502 }),
    redirect: ({ request, routeScope, status }) => {
      const redirectUrl = new URL(
        `/backoffice/automations/${backofficeRouteScopePath(routeScope)}/mcp`,
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
} satisfies PublicFragmentRoute<McpObject>;
