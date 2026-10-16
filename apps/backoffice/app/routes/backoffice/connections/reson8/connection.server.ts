import { integrationBasePath } from "../../integrations/connection-paths";
import { defineIntegrationConnection } from "../../integrations/connection.server";
import { fetchReson8Config } from "./data";

export const reson8Connection = defineIntegrationConnection({
  scopeKinds: ["org"],
  basePath: (scope) => integrationBasePath(scope, "reson8"),
  loadConfiguration: ({ context, scope }) => fetchReson8Config(context, scope.orgId),
  isConfigured: ({ configState }) => configState?.configured === true,
});
