import { redirect } from "react-router";

import { resolveAuthenticatedIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/organization-index";
import { fetchTelegramConfig } from "./data";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const scope = await resolveAuthenticatedIntegrationRuntimeScope({
    request,
    context,
    params,
  });
  const { configState } = await fetchTelegramConfig(context, scope);
  const target = configState?.configured ? "messages" : "configuration";
  return redirect(`${url.pathname.replace(/\/+$/u, "")}/${target}`);
}

export default function BackofficeOrganizationTelegramIndex() {
  return null;
}
