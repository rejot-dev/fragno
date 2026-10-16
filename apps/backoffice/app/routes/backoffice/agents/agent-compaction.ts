import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-compaction";
import { fetchPiManagerCompaction } from "./data";

/** Returns the durable task record for one manual Pi compaction. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerCompaction(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    params.taskId,
  );
}
