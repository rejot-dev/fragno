import type { IntegrationConnection } from "@fragno-dev/backoffice-api/v0/integrations";
import type { RouterContextProvider } from "react-router";

import { listConnectorCatalog } from "@/fragno/runtime-tools/families/integrations/connector-integration";
import { integrationConnectionKind } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type ConnectIntegrations = ReturnType<typeof createIntegrationsRuntime>;

/** The route scope's integrations, which the Connect page and its open source read and set up. */
export function connectIntegrations(context: Readonly<RouterContextProvider>): ConnectIntegrations {
  const { execution } = requireRouteScope(context);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  return createIntegrationsRuntime({ runtime, kernel, execution, nowEpochMs: Date.now });
}

/** Every provider the Connector's catalog lists, including those this project cannot connect yet. */
export function listConnectorProviders(context: Readonly<RouterContextProvider>) {
  const { execution } = requireRouteScope(context);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  return listConnectorCatalog({ runtime, context: { kernel, execution } });
}

export async function listConnections(
  integrations: ConnectIntegrations,
): Promise<IntegrationConnection[]> {
  const connections: IntegrationConnection[] = [];
  let cursor: string | null = null;
  do {
    const page = await integrations.list({ cursor });
    connections.push(...page.connections);
    cursor = page.cursor;
  } while (cursor !== null);
  return connections;
}

/** A Connector account that finished signing in; the list also holds names still waiting on one. */
export function isConnectedConnectorAccount(connection: IntegrationConnection): boolean {
  return (
    integrationConnectionKind(connection.connectionId) === "connector" &&
    connection.configuration.status === "configured"
  );
}
