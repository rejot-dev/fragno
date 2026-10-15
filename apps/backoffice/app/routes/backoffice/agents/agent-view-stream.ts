import type { Route } from "./+types/agent-view-stream";
import { resolvePiAgentRouteScope } from "./agent-scope.server";
import { fetchPiManagerAgentViewStream } from "./data";

/** Proxies the authorized durable agent NDJSON stream to the browser. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgentViewStream(
    request,
    context,
    await resolvePiAgentRouteScope(request, context, params),
    params.agentName,
  );
}
