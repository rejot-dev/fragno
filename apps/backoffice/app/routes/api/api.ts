import { forwardPublicFragmentRequest } from "@/fragno/public-fragment-route.server";

import type { Route } from "./+types/api";
import { apiPublicRoute } from "./api-route.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: apiPublicRoute,
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: apiPublicRoute,
  });
}
