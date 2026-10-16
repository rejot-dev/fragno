import { redirect } from "react-router";

import { resolveAuthenticatedIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/outbox-index";
import { fetchResendConfig } from "./data";

export async function loader({ context, url }: Route.LoaderArgs) {
  const scope = resolveAuthenticatedIntegrationRuntimeScope({
    context,
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
