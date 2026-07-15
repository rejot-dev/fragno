import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import type { Route } from "./+types/index";

export function meta() {
  return [
    { title: "GitHub Connection" },
    { name: "description", content: "Manage GitHub App connections." },
  ];
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const activeOrganizationId = me.activeOrganization?.organization.id;
  const fallbackOrganizationId = me.organizations[0]?.organization.id;
  const organizationId = activeOrganizationId ?? fallbackOrganizationId;

  if (!organizationId) {
    return redirect("/backoffice/connections");
  }

  return redirect(
    `/backoffice/automations/org/${encodeURIComponent(organizationId)}/integrations/github`,
  );
}

export default function BackofficeConnectionsGitHub() {
  return null;
}
