import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/index";
import { filesScopeBasePath } from "./scope";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const activeOrganization = me.activeOrganization?.organization;
  if (!activeOrganization) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(
    filesScopeBasePath({
      kind: "org",
      organization: { id: activeOrganization.id, slug: activeOrganization.slug },
    }),
  );
}

export default function BackofficeFilesIndex() {
  return null;
}
