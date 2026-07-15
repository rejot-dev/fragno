import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/index";
import { buildBackofficeLoginPath } from "./auth-navigation";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const orgId = me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id;
  if (!orgId) {
    return redirect("/backoffice/organisations");
  }

  return redirect(`/backoffice/automations/org/${orgId}/terminal`);
}

export default function BackofficeIndex() {
  return null;
}
