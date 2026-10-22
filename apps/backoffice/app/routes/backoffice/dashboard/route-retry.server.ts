import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { RouterContextProvider } from "react-router";

import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type RouteRetryActionData = { ok: true } | { ok: false; message: string };

/**
 * Runs a route that failed for good on an event again, as the signed-in user. Retrying runs the
 * route's action, so it needs the same permission as changing the route.
 */
export async function retryEventRoute(
  context: Readonly<RouterContextProvider>,
  { eventId, routeId }: { eventId: string; routeId: string },
): Promise<RouteRetryActionData> {
  const { execution } = requireRouteScope(context);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  try {
    return await kernel.invoke({
      execution,
      operation: BACKOFFICE_PERMISSION.router.modify,
      resource: { kind: "automation-route", routeId },
      execute: async (): Promise<RouteRetryActionData> => {
        const callRoute = createAutomationsRouteCaller({
          object: kernel.scoped("AUTOMATIONS", execution.scope, runtime.objects.automations),
        });
        const response = await callRoute("POST", "/events/:eventId/routes/:routeId/retry", {
          pathParams: { eventId, routeId },
        });
        if (response.type === "json") {
          return { ok: true };
        }
        return {
          ok: false,
          message:
            response.type === "error"
              ? response.error.message
              : `Retrying the route failed (${response.status}).`,
        };
      },
    });
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      return { ok: false, message: "You do not have permission to retry routes in this scope." };
    }
    throw error;
  }
}
