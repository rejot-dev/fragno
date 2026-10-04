import type { Route } from "./+types/session-view-stream";
import { fetchPiManagerSessionViewStream } from "./data";
import { resolvePiSessionRouteScope } from "./session-scope.server";

/** Proxies the authorized durable agent NDJSON stream to the browser. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const sessionId = params.sessionId;
  if (!sessionId) {
    throw new Response("Not Found", { status: 404 });
  }
  return await fetchPiManagerSessionViewStream(
    request,
    context,
    await resolvePiSessionRouteScope(request, context, params),
    sessionId,
  );
}
