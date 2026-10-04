import type { RouterContextProvider } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";

/** Resolves slug-backed session route parameters to the authorized runtime scope. */
export async function resolvePiSessionRouteScope(
  request: Request,
  context: Readonly<RouterContextProvider>,
  params: { scopeKind?: string; scopeId?: string },
) {
  const me = await requireBackofficeMe(request, context);
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  const resolvedScope = resolveBackofficeRouteScope(
    routeScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  return backofficeRuntimeScopeFromResolvedScope(resolvedScope);
}
