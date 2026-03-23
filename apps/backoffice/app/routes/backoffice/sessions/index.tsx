import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const orgId =
    me.activeOrganization?.organization.id ?? me.organizations?.[0]?.organization.id ?? null;

  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/sessions/${orgId}/sessions`);
}

export default function BackofficeSessionsIndex() {
  return null;
}
