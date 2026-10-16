import { redirect } from "react-router";

import type { Route } from "./+types/organization-index";
import { gitHubConnection } from "./connection.server";
import { gitHubRepositoriesRouteAvailable } from "./data";

export async function loader({ request, context }: Route.LoaderArgs) {
  const connection = gitHubConnection.require({ request, context });
  const { linkedRepositories } = await connection.configuration();
  const target =
    linkedRepositories && gitHubRepositoriesRouteAvailable(linkedRepositories)
      ? "repositories"
      : "configuration";
  return redirect(`${connection.basePath}/${target}`);
}

export default function BackofficeOrganizationGitHubIndex() {
  return null;
}
