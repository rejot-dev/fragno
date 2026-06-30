import { redirect } from "react-router";

import type { Route } from "./+types/organisation-index";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  gitHubRepositoriesRouteAvailable,
} from "./data";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const { configState } = await fetchGitHubAdminConfig(context, params.orgId, origin);
  const linkedRepositories = configState?.configured
    ? await fetchGitHubLinkedRepositories(request, context, params.orgId)
    : null;
  const target =
    linkedRepositories && gitHubRepositoriesRouteAvailable(linkedRepositories)
      ? "repositories"
      : "configuration";
  return redirect(`/backoffice/connections/github/${params.orgId}/${target}`);
}

export default function BackofficeOrganisationGitHubIndex() {
  return null;
}
