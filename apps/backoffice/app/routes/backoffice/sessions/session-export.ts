import type { Route } from "./+types/session-export";
import { fetchPiManagerSessionExport } from "./data";
import { resolvePiSessionRouteScope } from "./session-scope.server";

/** Streams the authorized durable Pi JSONL export without buffering it in the route process. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const sessionId = params.sessionId;
  if (!sessionId) {
    throw new Response("Not Found", { status: 404 });
  }
  return await fetchPiManagerSessionExport(
    request,
    context,
    await resolvePiSessionRouteScope(request, context, params),
    sessionId,
  );
}
