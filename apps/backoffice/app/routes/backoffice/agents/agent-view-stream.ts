import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-view-stream";
import { fetchPiManagerAgentViewStream } from "./data";

/** Proxies the authorized durable agent NDJSON stream to the browser. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgentViewStream(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
}
