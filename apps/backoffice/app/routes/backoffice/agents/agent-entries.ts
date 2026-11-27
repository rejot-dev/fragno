import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-entries";
import { fetchPiManagerEntryPage } from "./data";

/** Returns one authorized page of the agent's entries in an ID range, for the chat's transcript. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  // The manager validates the range; this route only forwards it.
  return await fetchPiManagerEntryPage(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    null,
    new URL(request.url).searchParams,
  );
}
