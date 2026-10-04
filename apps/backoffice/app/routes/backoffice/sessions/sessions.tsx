import { useOutletContext } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/sessions";
import { createSessionAction } from "./create-session-action";
import { fetchPiManagerSessions } from "./data";
import { PiSessionsWorkspace } from "./session-workspace";
import type { PiLayoutContext } from "./shared";

export { createSessionAction as action };

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const me = await requireBackofficeMe(request, context);
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  const resolvedScope = resolveBackofficeRouteScope(
    routeScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  return await fetchPiManagerSessions(
    request,
    context,
    backofficeRuntimeScopeFromResolvedScope(resolvedScope),
  );
}

export default function BackofficeOrganizationPiSessionsLayout({
  loaderData,
}: Route.ComponentProps) {
  const layoutContext = useOutletContext<PiLayoutContext>();
  return <PiSessionsWorkspace layoutContext={layoutContext} listing={loaderData} />;
}
