import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const orgId =
    me.activeOrganization?.organization.id ?? me.organizations?.[0]?.organization.id ?? null;

  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/automations/${orgId}/scripts`);
}

export default function BackofficeAutomationsIndex() {
  return null;
}
