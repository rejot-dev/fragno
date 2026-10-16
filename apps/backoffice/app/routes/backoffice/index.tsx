import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { dashboardPath } from "./dashboard/path";

export function loader({ context }: Route.LoaderArgs) {
  const activeOrganization = getBackofficeShellRequest(context).me.activeOrganization?.organization;
  if (!activeOrganization) {
    return redirect("/backoffice/organizations");
  }

  return redirect(dashboardPath({ kind: "org", orgSlug: activeOrganization.slug }));
}

export default function BackofficeIndex() {
  return null;
}
