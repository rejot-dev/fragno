import type { ProjectConnectorFragmentConfig } from "@fragno-dev/project-connector-fragment/definition";

import { createProjectConnectorFragment } from "@fragno-dev/project-connector-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

/** Mounts Connector on a user-owned scoped database adapter. */
export function createProjectConnectorServer(
  config: ProjectConnectorFragmentConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
) {
  return createProjectConnectorFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({ kind: "projectConnector" }),
    mountRoute: "/api/project-connector",
  }).withMiddleware(async function authorizeConnectorRoutes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    await ifMatchesRoute("GET", "/provider-configs", () => {
      access = BACKOFFICE_PERMISSION.connector.providersRead;
    });
    await ifMatchesRoute("GET", "/provider-configs/:providerConfigId/actions", () => {
      access = BACKOFFICE_PERMISSION.connector.providersRead;
    });
    await ifMatchesRoute("GET", "/status", () => {
      access = BACKOFFICE_PERMISSION.connector.accountsRead;
    });
    await ifMatchesRoute("GET", "/connection-requests/by-name", () => {
      access = BACKOFFICE_PERMISSION.connector.connectionsCreate;
    });
    await ifMatchesRoute("POST", "/connection-requests", () => {
      access = BACKOFFICE_PERMISSION.connector.connectionsCreate;
    });
    await ifMatchesRoute("POST", "/connection-requests/:requestId/refresh", () => {
      access = BACKOFFICE_PERMISSION.connector.connectionsCreate;
    });
    await ifMatchesRoute("GET", "/accounts", () => {
      access = BACKOFFICE_PERMISSION.connector.accountsRead;
    });
    await ifMatchesRoute("GET", "/accounts/by-name", () => {
      access = BACKOFFICE_PERMISSION.connector.accountsRead;
    });
    await ifMatchesRoute("GET", "/accounts/:accountId/profile", () => {
      access = BACKOFFICE_PERMISSION.connector.accountsRead;
    });
    await ifMatchesRoute("POST", "/accounts/:accountId/actions/:actionId", () => {
      access = BACKOFFICE_PERMISSION.connector.actionsExecute;
    });
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

/** The route caller derives its response types from the mounted fragment. */
export type ProjectConnectorFragment = ReturnType<typeof createProjectConnectorServer>;
