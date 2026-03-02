import { redirect } from "react-router";
import type { Route } from "./+types/organisation-telegram-index";
import { fetchTelegramConfig } from "./organisation-telegram-data";

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState } = await fetchTelegramConfig(context, params.orgId);
  const target = configState?.configured ? "messages" : "configuration";
  return redirect(`/backoffice/organisations/${params.orgId}/telegram/${target}`);
}

export default function BackofficeOrganisationTelegramIndex() {
  return null;
}
