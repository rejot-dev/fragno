import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-subagent-entries";
import { fetchPiManagerEntryPage } from "./data";

/** Returns one authorized page of a subagent's entries in an ID range, for its transcript. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  // The manager validates the range; this route only forwards it.
  return await fetchPiManagerEntryPage(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    params.requestId,
    new URL(request.url).searchParams,
  );
}
