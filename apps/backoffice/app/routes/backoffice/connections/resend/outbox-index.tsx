import { redirect } from "react-router";

import { resolveScopeFromRouteParams } from "../../integrations/scope";
import type { Route } from "./+types/outbox-index";
import { fetchResendConfig } from "./data";

export async function loader({ params, context, url }: Route.LoaderArgs) {
  const scope = resolveScopeFromRouteParams(params);

  const { configState } = await fetchResendConfig(context, scope);
  if (!configState?.configured) {
    return redirect(
      `${url.pathname.replace(/\/(?:domains|threads|incoming|outgoing)(?:\/.*)?$/u, "")}/configuration`,
    );
  }

  return redirect(`${url.pathname.replace(/\/+$/u, "")}/send`);
}

export default function BackofficeOrganisationResendOutboxIndex() {
  return null;
}
