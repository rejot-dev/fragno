import type { RouterContextProvider } from "react-router";

import {
  forwardToScopedAutomationsFragment,
  type AutomationsScopedRouteParams,
} from "./automations-scoped.server";

const AUTOMATIONS_WORKFLOWS_MOUNT = "/api/automations-workflows";

const forwardToScopedWorkflows = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  params: AutomationsScopedRouteParams,
) =>
  forwardToScopedAutomationsFragment({
    request,
    context,
    params,
    mountRoute: AUTOMATIONS_WORKFLOWS_MOUNT,
  });

export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsScopedRouteParams;
}) {
  return forwardToScopedWorkflows(request, context, params);
}

export async function action({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsScopedRouteParams;
}) {
  return forwardToScopedWorkflows(request, context, params);
}
