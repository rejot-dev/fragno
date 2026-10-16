import { defineIntegrationConnection } from "../../integrations/connection.server";
import { fetchUploadConfig } from "./data";

export const uploadConnection = defineIntegrationConnection({
  scopeKinds: ["org"],
  basePath: (scope) =>
    `/backoffice/connections/upload/${encodeURIComponent(scope.organization.slug)}`,
  loadConfiguration: ({ context, scope }) => fetchUploadConfig(context, scope.orgId),
  isConfigured: ({ configState }) => configState?.configured === true,
});
