import { redirect } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/durable-hooks-scope-redirect";
import {
  defaultDurableHooksObjectForScope,
  durableHooksScopePath,
  getDurableHooksObjectDefinition,
  isDurableHooksObjectAllowedForScope,
} from "./durable-hooks-scope";

export function loader({ context, url }: Route.LoaderArgs) {
  const { resolvedScope } = requireRouteScope(context);
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const requestedObject = getDurableHooksObjectDefinition(url.searchParams.get("object"));
  const objectId =
    requestedObject && isDurableHooksObjectAllowedForScope(requestedObject.id, runtimeScope)
      ? requestedObject.id
      : defaultDurableHooksObjectForScope(runtimeScope);

  return redirect(
    durableHooksScopePath(backofficeRouteScopeFromResolvedScope(resolvedScope), objectId),
  );
}

export default function BackofficeDurableHooksScopeRedirect() {
  return null;
}
