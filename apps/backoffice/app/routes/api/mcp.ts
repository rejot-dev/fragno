import { forwardPublicFragmentRequest } from "@/fragno/public-fragment-route.server";

import type { Route } from "./+types/mcp";
import { mcpPublicRoute } from "./mcp-route.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: mcpPublicRoute,
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: mcpPublicRoute,
  });
}
