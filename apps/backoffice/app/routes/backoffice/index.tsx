import { redirect } from "react-router";

import { getBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/index";
import { buildBackofficeAuthBootstrapPath } from "./auth-navigation";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const jwtMe = await getBackofficeMe(request, context);
  if (jwtMe.status !== "authenticated") {
    return redirect(buildBackofficeAuthBootstrapPath(`${url.pathname}${url.search}`));
  }

  const me = jwtMe.me;
  const orgId = me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id;
  if (!orgId) {
    return redirect("/backoffice/organisations");
  }

  return redirect(`/backoffice/automations/org/${orgId}/dashboard`);
}

export default function BackofficeIndex() {
  return null;
}
