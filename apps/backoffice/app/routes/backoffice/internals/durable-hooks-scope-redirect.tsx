import { redirect } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { isBackofficeScopeCodecError } from "@/backoffice-runtime/scope-codec";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/durable-hooks-scope-redirect";
import {
  defaultDurableHooksObjectForScope,
  durableHooksScopePath,
  getDurableHooksObjectDefinition,
  isDurableHooksObjectAllowedForScope,
} from "./durable-hooks-scope";

export async function loader({ request, context, params, url }: Route.LoaderArgs) {
  let routeScope;
  try {
    routeScope = requireBackofficeRouteScopeFromParams(params);
  } catch (error) {
    if (isBackofficeScopeCodecError(error)) {
      throw new Response("Not Found", { status: 404 });
    }
    throw error;
  }

  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw new Response("Unauthorized", { status: 401 });
  }
  const resolvedScope = resolveBackofficeRouteScope(
    routeScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);

  const requestedObject = getDurableHooksObjectDefinition(url.searchParams.get("object"));
  const objectId =
    requestedObject && isDurableHooksObjectAllowedForScope(requestedObject.id, runtimeScope)
      ? requestedObject.id
      : defaultDurableHooksObjectForScope(runtimeScope);

  return redirect(durableHooksScopePath(routeScope, objectId));
}

export default function BackofficeDurableHooksScopeRedirect() {
  return null;
}
