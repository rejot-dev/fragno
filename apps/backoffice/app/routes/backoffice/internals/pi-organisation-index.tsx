import { redirect } from "react-router";

import type { Route } from "./+types/pi-organisation-index";

export async function loader({ params }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/internals/pi/${params.orgId}/harnesses`);
}

export default function BackofficeInternalsPiOrganisationIndex() {
  return null;
}
