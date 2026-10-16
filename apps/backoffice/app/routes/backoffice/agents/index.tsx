import { redirect } from "react-router";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const activeOrganization = me.activeOrganization?.organization;
  if (!activeOrganization) {
    throw new Response("Not Found", { status: 404 });
  }

  const scopePath = backofficeRouteScopePath({
    kind: "org",
    orgSlug: activeOrganization.slug,
  });
  return redirect(`/backoffice/agents/${scopePath}/agents`);
}

export default function BackofficeAgentsIndex() {
  return null;
}
