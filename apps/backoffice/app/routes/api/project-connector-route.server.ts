import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import type { ProjectConnectorObject } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
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
  isAnonymousRequest: (request, _scope, suffix) =>
    request.method === "GET" && suffix === "/oauth/callback",
  forwardRequest: async ({
    context,
    execution,
    getObject,
    request,
    routeScope,
    publicPathSuffix,
  }) => {
    if (request.method === "GET" && publicPathSuffix === "/oauth/callback") {
      // The SaaS gateway owns OAuth state. Neither status nor account IDs in this browser
      // return prove anything; the initiating agent/UI retains the original request ID.
      const destination = new URL(
        `/backoffice/connections/connector/return/${encodeURIComponent(backofficeRouteScopeSinglePathSegment(routeScope))}`,
        request.url,
      );
      return Response.redirect(destination, 302);
    }
    const segments = publicPathSuffix.split("/").filter(Boolean);
    if (request.method === "POST" && segments[0] === "accounts" && segments[2] === "actions") {
      if (!execution) {
        return new Response("Authentication required", { status: 401 });
      }
      try {
        return await context.get(BackofficeWorkerContext).kernel.invoke({
          execution,
          operation: BACKOFFICE_PERMISSION.connector.actionsExecute,
          execute: () => getObject().http.fetch(request),
        });
      } catch (error) {
        if (isBackofficeForbiddenError(error)) {
          return new Response(error.message, { status: 403 });
        }
        throw error;
      }
    }
    return await getObject().http.fetch(request);
  },
} satisfies PublicFragmentRoute<ProjectConnectorObject>;
