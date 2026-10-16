import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { dashboardPath } from "./path";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  const activeOrganization = me.activeOrganization?.organization;
  if (!activeOrganization) {
    throw new Response("Not Found", { status: 404 });
  }
  return redirect(dashboardPath({ kind: "org", orgSlug: activeOrganization.slug }));
}

export default function BackofficeDashboardIndex() {
  return null;
}
