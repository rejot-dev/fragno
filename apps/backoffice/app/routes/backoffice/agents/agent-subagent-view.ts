import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-subagent-view";
import { fetchPiManagerSubagentView } from "./data";

/** One subagent's conversation view, by the request ID that started it. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return {
    view: await fetchPiManagerSubagentView(
      request,
      context,
      requireRouteScope(context).execution.scope,
      params.agentName,
      params.requestId,
    ),
  };
}
