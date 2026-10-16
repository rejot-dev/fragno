import { redirect } from "react-router";

import { resolveAuthenticatedIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/organization-index";
import { fetchTelegramConfig } from "./data";

export async function loader({ context, url }: Route.LoaderArgs) {
  const scope = resolveAuthenticatedIntegrationRuntimeScope({
    context,
  });
  const { configState } = await fetchTelegramConfig(context, scope);
  const target = configState?.configured ? "messages" : "configuration";
  return redirect(`${url.pathname.replace(/\/+$/u, "")}/${target}`);
}

export default function BackofficeOrganizationTelegramIndex() {
  return null;
}
