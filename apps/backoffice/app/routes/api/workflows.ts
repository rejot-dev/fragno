import type { Route } from "./+types/workflows";
import { forwardScopedWorkflowsRequest } from "./scoped-workflows";

/** Authenticated scope-aware proxy for the Workflows fragment hosted by Automations. */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardScopedWorkflowsRequest({ request, context, params });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardScopedWorkflowsRequest({ request, context, params });
}
