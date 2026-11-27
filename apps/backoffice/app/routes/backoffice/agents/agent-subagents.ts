import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-subagents";
import { fetchPiManagerSubagents } from "./data";

/**
 * Returns the page of the agent's subagents that `cursor`, an earlier page's `older.cursor`,
 * continues at, for the history its page loads; its view socket sends the newest page.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor === null) {
    throw new Response("A subagent cursor is required.", { status: 400 });
  }
  return await fetchPiManagerSubagents(
    request,
    context,
    requireRouteScope(context).execution.scope,
    params.agentName,
    cursor,
  );
}
