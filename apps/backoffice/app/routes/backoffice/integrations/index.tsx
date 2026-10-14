import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/index";
import { integrationsScopeBasePath } from "./connection-paths";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }
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
