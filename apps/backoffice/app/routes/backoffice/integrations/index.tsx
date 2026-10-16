import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { integrationsScopeBasePath } from "./connection-paths";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  const activeOrganization = me.activeOrganization?.organization;
  if (!activeOrganization) {
    throw new Response("Not Found", { status: 404 });
  }
  return redirect(
    integrationsScopeBasePath({
      kind: "org",
      organization: { id: activeOrganization.id, slug: activeOrganization.slug },
      label: activeOrganization.name,
    }),
  );
}

export default function BackofficeIntegrationsIndex() {
  return null;
}
