import { redirect } from "react-router";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const orgId =
    me.activeOrganization?.organization.id ?? me.organizations?.[0]?.organization.id ?? null;

  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const scopePath = backofficeContextScopeRoutePath({ kind: "org", orgId });
  return redirect(`/backoffice/sessions/${scopePath}/sessions`);
}

export default function BackofficeSessionsIndex() {
  return null;
}
