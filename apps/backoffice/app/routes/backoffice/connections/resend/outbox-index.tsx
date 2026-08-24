import { redirect } from "react-router";

import { resolveAuthenticatedIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/outbox-index";
import { fetchResendConfig } from "./data";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const scope = await resolveAuthenticatedIntegrationRuntimeScope({
    request,
    context,
    params,
    allowedScopes: ["org", "system"],
  });

  const { configState } = await fetchResendConfig(context, scope);
  if (!configState?.configured) {
    return redirect(
      `${url.pathname.replace(/\/(?:domains|threads|incoming|outgoing)(?:\/.*)?$/u, "")}/configuration`,
    );
  }

  return redirect(`${url.pathname.replace(/\/+$/u, "")}/send`);
}

export default function BackofficeOrganizationResendOutboxIndex() {
  return null;
}
