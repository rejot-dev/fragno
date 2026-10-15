import type { Route } from "./+types/agent-compaction";
import { resolvePiAgentRouteScope } from "./agent-scope.server";
import { fetchPiManagerCompaction } from "./data";

/** Returns the durable task record for one manual Pi compaction. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerCompaction(
    request,
    context,
    await resolvePiAgentRouteScope(request, context, params),
    params.agentName,
    params.taskId,
  );
}
