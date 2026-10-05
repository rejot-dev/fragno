import type { ProjectConnectorObject } from "@/backoffice-runtime/object-registry";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import {
  PROJECT_CONNECTOR_INTERNAL_PREFIX,
  PROJECT_CONNECTOR_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

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
    redirect: ({ request, routeScope }) => {
      // The gateway owns OAuth state; this navigation neither creates an object nor binds an account.
      return Response.redirect(
        new URL(
          `/backoffice/connections/connector/return/${encodeURIComponent(backofficeRouteScopeSinglePathSegment(routeScope))}`,
          request.url,
        ),
        302,
      );
    },
  },
} satisfies PublicFragmentRoute<ProjectConnectorObject>;
