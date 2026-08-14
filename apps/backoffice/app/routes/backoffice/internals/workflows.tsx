import { redirect } from "react-router";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/workflows";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const scope = me.activeOrganization?.organization.id
    ? ({ kind: "org", orgId: me.activeOrganization.organization.id } as const)
    : ({ kind: "user", userId: me.user.id } as const);

  return redirect(`/backoffice/internals/workflows/${backofficeContextScopeRoutePath(scope)}`);
}

export default function BackofficeWorkflowsRedirect() {
  return null;
}
