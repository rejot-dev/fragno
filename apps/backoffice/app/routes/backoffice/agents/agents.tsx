import { useOutletContext } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/agents";
import { PiAgentsWorkspace } from "./agents-workspace";
import { fetchPiManagerAgents } from "./data";
import type { PiLayoutContext } from "./shared";

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
  return await fetchPiManagerAgents(
    request,
    context,
    backofficeRuntimeScopeFromResolvedScope(resolvedScope),
  );
}

export default function BackofficeOrganizationPiAgentsLayout({ loaderData }: Route.ComponentProps) {
  const layoutContext = useOutletContext<PiLayoutContext>();
  return <PiAgentsWorkspace layoutContext={layoutContext} directory={loaderData} />;
}
