import { redirect } from "react-router";

import { resolveOrganizationScopeFromRouteParams } from "../../integrations/scope";
import type { Route } from "./+types/organisation-index";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  gitHubRepositoriesRouteAvailable,
} from "./data";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const organizationScope = resolveOrganizationScopeFromRouteParams(params);
  const organizationId = organizationScope.organizationId;

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

export default function BackofficeOrganisationGitHubIndex() {
  return null;
}
