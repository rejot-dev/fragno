import { redirect } from "react-router";

import { resolveScopeFromRouteParams } from "../../integrations/scope";
import type { Route } from "./+types/organisation-index";
import { fetchTelegramConfig } from "./data";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const scope = resolveScopeFromRouteParams(params);
  const { configState } = await fetchTelegramConfig(context, scope);
  const target = configState?.configured ? "messages" : "configuration";
  return redirect(`${new URL(request.url).pathname.replace(/\/+$/u, "")}/${target}`);
}

export default function BackofficeOrganisationTelegramIndex() {
  return null;
}
