import { redirect } from "react-router";
import type { Route } from "./+types/organisation-index";

export async function loader({ params }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/sessions/${params.orgId}/sessions`);
}

export default function BackofficeOrganisationPiIndex() {
  return null;
}
