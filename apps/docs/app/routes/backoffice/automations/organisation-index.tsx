import { redirect } from "react-router";

import type { Route } from "./+types/organisation-index";

export async function loader({ params }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/automations/${params.orgId}/scripts`);
}

export default function BackofficeOrganisationAutomationsIndex() {
  return null;
}
