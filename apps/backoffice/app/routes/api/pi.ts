import type { Route } from "./+types/pi";
import { forwardScopedPiRequest } from "./scoped-pi";

/** Authenticated scope-aware proxy for the Pi fragment and its outbox. */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardScopedPiRequest({
    request,
    context,
    params,
    mountRoute: "/api/pi",
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardScopedPiRequest({
    request,
    context,
    params,
    mountRoute: "/api/pi",
  });
}
