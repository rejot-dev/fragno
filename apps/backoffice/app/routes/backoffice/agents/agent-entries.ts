import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-entries";
import { fetchPiManagerEntryPage } from "./data";

/** Returns one authorized newest-first page of the history before the agent's active context. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { searchParams } = new URL(request.url);
  // The manager validates the query; this route only forwards it.
  return await fetchPiManagerEntryPage(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    {
      before: searchParams.get("before") ?? "",
      cursor: searchParams.get("cursor"),
      pageSize: searchParams.get("pageSize") ?? "",
    },
  );
}
