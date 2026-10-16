import type { McpObject } from "@/backoffice-runtime/object-registry";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import { encodeMcpConnectionId } from "@/fragno/runtime-tools/families/integrations/mcp-integration";
import {
  MCP_INTERNAL_OAUTH_CALLBACK_PATH,
  MCP_INTERNAL_PREFIX,
  MCP_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { integrationOAuthReturn } from "../backoffice/integrations/connection-paths";

export const mcpPublicRoute = {
  publicPrefix: MCP_PUBLIC_PREFIX,
  internalPrefix: MCP_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.mcp.for(scope),
  publicIngress: null,
  oauth: {
    internalCallbackPath: MCP_INTERNAL_OAUTH_CALLBACK_PATH,
    invalidResponse: (message) => new Response(message, { status: 502 }),
    redirect: ({ request, pageScope, status, message }) => {
      const slug = new URL(request.url).searchParams.get("state")?.split(":")[0]?.trim();
      return integrationOAuthReturn({
        request,
        routeScope: pageScope,
        connectionId: slug ? encodeMcpConnectionId(slug) : null,
        outcome: status === "success" ? { status } : { status, message: message ?? null },
      });
    },
  },
} satisfies PublicFragmentRoute<McpObject>;
