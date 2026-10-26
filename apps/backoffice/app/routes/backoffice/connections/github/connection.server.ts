import { integrationBasePath } from "../../integrations/connection-paths";
import { defineIntegrationConnection } from "../../integrations/connection.server";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  gitHubRepositoriesRouteAvailable,
} from "./data";

/** GitHub is configured once its app is set up and the organization has linked repositories. */
export const gitHubConnection = defineIntegrationConnection({
  scopeKinds: ["org"],
  basePath: (scope) => integrationBasePath(scope, "github"),
  async loadConfiguration({ request, context, scope }) {
    const config = await fetchGitHubAdminConfig(context, scope.orgId, new URL(request.url).origin);
    const linkedRepositories = config.configState?.configured
      ? await fetchGitHubLinkedRepositories(request, context, scope)
      : null;
    return { ...config, linkedRepositories };
  },
  isConfigured: ({ linkedRepositories }) =>
    linkedRepositories !== null && gitHubRepositoriesRouteAvailable(linkedRepositories),
});
