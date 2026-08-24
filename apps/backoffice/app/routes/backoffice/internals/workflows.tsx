import { redirect } from "react-router";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { getBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeAuthBootstrapPath } from "../auth-navigation";
import type { Route } from "./+types/workflows";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const result = await getBackofficeMe(request, context);
  if (result.status !== "authenticated") {
    return Response.redirect(
      new URL(buildBackofficeAuthBootstrapPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }
  const me = result.me;

  const scope = me.activeOrganization?.organization
    ? ({ kind: "org", orgSlug: me.activeOrganization.organization.slug } as const)
    : ({ kind: "user", userId: me.user.id } as const);

  return redirect(`/backoffice/internals/workflows/${backofficeRouteScopePath(scope)}`);
}

export default function BackofficeWorkflowsRedirect() {
  return null;
}
