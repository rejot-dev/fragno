import { redirect } from "react-router";

import type { Route } from "./+types/outbox-index";
import { fetchResendConfig } from "./data";

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState } = await fetchResendConfig(context, params.orgId);
  if (!configState?.configured) {
    return redirect(`/backoffice/connections/resend/${params.orgId}/configuration`);
  }

  return redirect(`/backoffice/connections/resend/${params.orgId}/outgoing/send`);
}

export default function BackofficeOrganisationResendOutboxIndex() {
  return null;
}
