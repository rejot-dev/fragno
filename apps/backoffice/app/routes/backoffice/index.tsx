import { redirect } from "react-router";

import { getBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/index";
import { buildBackofficeAuthBootstrapPath } from "./auth-navigation";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const jwtMe = await getBackofficeMe(request, context);
  if (jwtMe.status !== "authenticated") {
    return redirect(buildBackofficeAuthBootstrapPath(`${url.pathname}${url.search}`));
  }

  const activeOrganization = jwtMe.me.activeOrganization?.organization;
  if (!activeOrganization) {
    return redirect("/backoffice/organizations");
  }

  return redirect(
    `/backoffice/automations/org/${encodeURIComponent(activeOrganization.slug)}/dashboard`,
  );
}

export default function BackofficeIndex() {
  return null;
}
