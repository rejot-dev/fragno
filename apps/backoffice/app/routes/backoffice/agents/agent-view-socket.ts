import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-view-socket";
import { openPiAgentViewSocket } from "./data";

/** Upgrades to the agent's view socket, which the agent object serves directly. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await openPiAgentViewSocket(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
}
