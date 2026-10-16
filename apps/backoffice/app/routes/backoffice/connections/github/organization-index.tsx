import { redirect } from "react-router";

import { resolveAuthenticatedOrgIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/organization-index";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  gitHubRepositoriesRouteAvailable,
} from "./data";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const { orgId: organizationId } = resolveAuthenticatedOrgIntegrationRuntimeScope({
    context,
  });

  const origin = url.origin;
  const { configState } = await fetchGitHubAdminConfig(context, organizationId, origin);
  const linkedRepositories = configState?.configured
    ? await fetchGitHubLinkedRepositories(request, context, organizationId)
    : null;
  const target =
    linkedRepositories && gitHubRepositoriesRouteAvailable(linkedRepositories)
      ? "repositories"
      : "configuration";
  return redirect(`${url.pathname.replace(/\/+$/u, "")}/${target}`);
}

export default function BackofficeOrganizationGitHubIndex() {
  return null;
}
