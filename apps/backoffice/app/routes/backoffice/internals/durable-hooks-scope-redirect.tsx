import { redirect } from "react-router";

import type { Route } from "./+types/durable-hooks-scope-redirect";
import {
  defaultDurableHooksObjectForScope,
  durableHooksContextScopeFromRouteId,
  durableHooksScopePath,
  getDurableHooksObjectDefinition,
  isDurableHooksObjectAllowedForScope,
} from "./durable-hooks-scope";

export async function loader({ params, url }: Route.LoaderArgs) {
  const scope = durableHooksContextScopeFromRouteId(params.scopeId);
  if (!scope) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestedObject = getDurableHooksObjectDefinition(url.searchParams.get("object"));
  const objectId =
    requestedObject && isDurableHooksObjectAllowedForScope(requestedObject.id, scope)
      ? requestedObject.id
      : defaultDurableHooksObjectForScope(scope);

  return redirect(durableHooksScopePath(scope, objectId));
}

export default function BackofficeDurableHooksScopeRedirect() {
  return null;
}
