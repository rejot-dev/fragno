import { redirect } from "react-router";

import type { Route } from "./+types/organization-index";
import { telegramConnection } from "./connection.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const connection = telegramConnection.require({ request, context });
  const { configState } = await connection.configuration();
  const target = configState?.configured ? "messages" : "configuration";
  return redirect(`${connection.basePath}/${target}`);
}

export default function BackofficeOrganizationTelegramIndex() {
  return null;
}
