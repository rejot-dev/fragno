import type { Route } from "./+types/session-compaction";
import { fetchPiManagerCompaction } from "./data";
import { resolvePiSessionRouteScope } from "./session-scope.server";

/** Returns the durable task record for one manual Pi compaction. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { sessionId, taskId } = params;
  if (!sessionId || !taskId) {
    throw new Response("Not Found", { status: 404 });
  }
  return await fetchPiManagerCompaction(
    request,
    context,
    await resolvePiSessionRouteScope(request, context, params),
    sessionId,
    taskId,
  );
}
