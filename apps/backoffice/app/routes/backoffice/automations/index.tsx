import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/index";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
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

  return redirect(`/backoffice/automations/org/${orgId}/dashboard`);
}

export default function BackofficeAutomationsIndex() {
  return null;
}
