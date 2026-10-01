import { forwardPublicFragmentRequest } from "@/fragno/public-fragment-route.server";

import type { Route } from "./+types/project-connector";
import { projectConnectorPublicRoute } from "./project-connector-route.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return await forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: projectConnectorPublicRoute,
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return await forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: projectConnectorPublicRoute,
  });
}
