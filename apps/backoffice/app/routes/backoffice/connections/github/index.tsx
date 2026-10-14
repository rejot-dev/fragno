import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import type { Route } from "./+types/index";

export function meta() {
  return [
    { title: "GitHub Connection" },
    { name: "description", content: "Manage GitHub App connections." },
  ];
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const activeOrganization = me.activeOrganization?.organization;
  if (!activeOrganization) {
    return redirect("/backoffice/integrations");
  }

  return redirect(
    `/backoffice/integrations/org/${encodeURIComponent(activeOrganization.slug)}/github`,
  );
}

export default function BackofficeConnectionsGitHub() {
  return null;
}
