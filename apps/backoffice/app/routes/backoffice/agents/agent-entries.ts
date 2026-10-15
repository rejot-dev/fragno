import type { Route } from "./+types/agent-entries";
import { resolvePiAgentRouteScope } from "./agent-scope.server";
import { fetchPiManagerEntryPage } from "./data";

/** Returns one authorized newest-first page from the durable Pi transcript history. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
  return await fetchPiManagerEntryPage(
    request,
    context,
    await resolvePiAgentRouteScope(request, context, params),
    params.agentName,
    { cursor: url.searchParams.get("cursor"), pageSize },
  );
}
