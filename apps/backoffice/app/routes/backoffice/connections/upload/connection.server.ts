import { defineIntegrationConnection } from "../../integrations/connection.server";

export const uploadConnection = defineIntegrationConnection({
  scopeKinds: ["org"],
  basePath: (scope) =>
    `/backoffice/connections/upload/${encodeURIComponent(scope.organization.slug)}`,
  // Every organization stores its files in its own database, so there is nothing to configure.
  loadConfiguration: async () => ({ configError: null }),
  isConfigured: () => true,
});
