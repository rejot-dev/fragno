import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/agent-drawer-data";
import { fetchPiManagerAgent } from "./data";
import { loadPiLayoutData } from "./layout-data.server";

/** The agent with its scope's agent context, for conversations shown outside the agents pages. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const [lookup, layout] = await Promise.all([
    fetchPiManagerAgent(
      request,
      context,
      requireRouteScope(context).execution.scope,
      params.agentName,
    ),
    loadPiLayoutData(request, context),
  ]);
  return {
    lookup,
    usageLabel: layout.usageLabel,
    availableModelOptions: layout.availableModelOptions,
    dictationMountRoute: layout.dictationMountRoute,
  };
}
