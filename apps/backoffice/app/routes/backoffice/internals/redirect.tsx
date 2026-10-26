import { redirect } from "react-router";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/redirect";

export async function loader({ context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const organization =
    me.activeOrganization?.organization ?? me.organizations[0]?.organization ?? null;
  const scope = organization
    ? ({ kind: "org", orgSlug: organization.slug } as const)
    : ({ kind: "user", userId: me.user.id, jurisdiction: me.user.jurisdiction } as const);

  return redirect(`/backoffice/internals/${backofficeRouteScopePath(scope)}`);
}

export default function BackofficeInternalsRedirect() {
  return null;
}
