import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-export";
import { fetchPiManagerAgentExport } from "./data";

/** Streams the authorized durable Pi JSONL export without buffering it in the route process. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgentExport(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
  );
}
