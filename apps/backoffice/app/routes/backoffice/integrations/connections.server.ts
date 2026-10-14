import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import type { IntegrationAuthMethod } from "@fragno-dev/backoffice-api/v0/integrations";
import type { RouterContextProvider } from "react-router";

import { createRuntimeToolHandlers } from "@/backoffice-api/runtime-tool-handlers";
import { backofficeApiV0Adapters } from "@/backoffice-api/v0-adapters";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { requireAutomationRouteExecution } from "../automations/scope.server";

const handlers = createRuntimeToolHandlers(backofficeApiV0, backofficeApiV0Adapters);

export type ListedIntegrationConnections =
  | {
      status: "listed";
      connections: Record<string, { name: string; authMethod: IntegrationAuthMethod | null }>;
    }
  | { status: "unavailable"; message: string };

/**
 * The source-owned name and auth method of each configured connection. Connection events carry
 * neither, so the overview reads them through integrations.list with the user's own authority.
 */
export async function listIntegrationConnections(
  request: Request,
  context: Readonly<RouterContextProvider>,
  params: { scopeKind?: string; scopeId?: string },
): Promise<ListedIntegrationConnections> {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const toolContext = createBackofficeToolContext(
    createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution: await requireAutomationRouteExecution(request, context, params),
      billingOrganizationId: null,
    }),
  );
  const connections: Extract<ListedIntegrationConnections, { status: "listed" }>["connections"] =
    {};
  try {
    let cursor: string | null = null;
    do {
      const page = await handlers["integrations.list"]({ cursor }, toolContext);
      for (const connection of page.connections) {
        connections[connection.connectionId] = {
          name: connection.name,
          authMethod: connection.authMethod,
        };
      }
      cursor = page.cursor;
    } while (cursor !== null);
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Connections could not be listed.",
    };
  }
  return { status: "listed", connections };
}
