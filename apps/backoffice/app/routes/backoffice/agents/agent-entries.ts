import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-entries";
import { fetchPiManagerEntryPage } from "./data";

/** Returns one authorized newest-first page from the durable Pi transcript history. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
  return await fetchPiManagerEntryPage(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    { cursor: url.searchParams.get("cursor"), pageSize },
  );
}
