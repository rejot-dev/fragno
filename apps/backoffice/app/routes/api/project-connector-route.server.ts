import type { ProjectConnectorObject } from "@/backoffice-runtime/object-registry";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import {
  PROJECT_CONNECTOR_INTERNAL_PREFIX,
  PROJECT_CONNECTOR_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { integrationOAuthReturn } from "../backoffice/integrations/connection-paths";

/** OAuth returns are navigation only; authenticated refresh is the sole account-binding operation. */
export const projectConnectorPublicRoute = {
  publicPrefix: PROJECT_CONNECTOR_PUBLIC_PREFIX,
  internalPrefix: PROJECT_CONNECTOR_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.projectConnector.for(scope),
  isScopeSupported: (scope) => scope.kind === "user",
  publicIngress: {
    kind: "redirect",
    matches: (request, _scope, suffix) => request.method === "GET" && suffix === "/oauth/callback",
    // The gateway owns OAuth state, so this navigation neither knows the connection nor binds an
    // account, and none of the provider's query reaches the landing page.
    redirect: ({ request, routeScope }) =>
      integrationOAuthReturn({
        request,
        routeScope,
        connectionId: null,
        outcome: { status: "returned" },
      }),
  },
} satisfies PublicFragmentRoute<ProjectConnectorObject>;
