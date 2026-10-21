import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { dashboardPath } from "./path";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  return redirect(dashboardPath({ kind: "user", userId: me.user.id }));
}

export default function BackofficeDashboardIndex() {
  return null;
}
