import { redirect } from "react-router";

import type { Route } from "./+types/organisation-index";

export function loader({ params }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }
  return redirect(`/backoffice/connections/mcp/${params.orgId}/configuration`);
}

export default function BackofficeOrganisationMcpIndex() {
  return null;
}
