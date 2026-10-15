import type { Route } from "./+types/agent-export";
import { resolvePiAgentRouteScope } from "./agent-scope.server";
import { fetchPiManagerAgentExport } from "./data";

/** Streams the authorized durable Pi JSONL export without buffering it in the route process. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgentExport(
    request,
    context,
    await resolvePiAgentRouteScope(request, context, params),
    params.agentName,
  );
}
