import { redirect } from "react-router";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const activeOrganization = me.activeOrganization?.organization;
  if (!activeOrganization) {
    throw new Response("Not Found", { status: 404 });
  }

  const scopePath = backofficeRouteScopePath({
    kind: "org",
    orgSlug: activeOrganization.slug,
  });
  return redirect(`/backoffice/sessions/${scopePath}/sessions`);
}

export default function BackofficeSessionsIndex() {
  return null;
}
