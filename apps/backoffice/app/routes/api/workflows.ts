import type { Route } from "./+types/workflows";
import { forwardScopedPiRequest } from "./scoped-pi";

/** Authenticated scope-aware proxy for the workflows fragment hosted by Pi. */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardScopedPiRequest({
    request,
    context,
    params,
    mountRoute: "/api/pi-workflows",
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardScopedPiRequest({
    request,
    context,
    params,
    mountRoute: "/api/pi-workflows",
  });
}
