import { redirect } from "react-router";

import type { Route } from "./+types/threads-index";

export async function loader({ params }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/connections/resend/${params.orgId}/threads/start`);
}

export default function BackofficeOrganisationResendThreadsIndex() {
  return null;
}
