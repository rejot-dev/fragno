import { useOutletContext } from "react-router";

import {} from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agents";
import { PiAgentsWorkspace } from "./agents-workspace";
import { fetchPiManagerAgents } from "./data";
import type { PiLayoutContext } from "./shared";

export async function loader({ request, context }: Route.LoaderArgs) {
  return await fetchPiManagerAgents(request, context, requireRouteScope(context).execution.scope);
}

export default function BackofficeOrganizationPiAgentsLayout({ loaderData }: Route.ComponentProps) {
  const layoutContext = useOutletContext<PiLayoutContext>();
  return <PiAgentsWorkspace layoutContext={layoutContext} directory={loaderData} />;
}
