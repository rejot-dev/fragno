import { redirect } from "react-router";

import type { Route } from "./+types/workflows-organisation-redirect";

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const requestedFragment = url.searchParams.get("fragment");
  const fragment = requestedFragment === "pi" ? requestedFragment : "pi";
  return redirect(`/backoffice/internals/workflows/${params.orgId}/${fragment}`);
}

export default function BackofficeWorkflowsOrganisationRedirect() {
  return null;
}
