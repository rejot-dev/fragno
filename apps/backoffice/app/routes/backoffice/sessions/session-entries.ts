import type { Route } from "./+types/session-entries";
import { fetchPiManagerEntryPage } from "./data";
import { resolvePiSessionRouteScope } from "./session-scope.server";

/** Returns one authorized newest-first page from the durable Pi transcript history. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const sessionId = params.sessionId;
  if (!sessionId) {
    throw new Response("Not Found", { status: 404 });
  }
  const url = new URL(request.url);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
  return await fetchPiManagerEntryPage(
    request,
    context,
    await resolvePiSessionRouteScope(request, context, params),
    sessionId,
    { cursor: url.searchParams.get("cursor"), pageSize },
  );
}
