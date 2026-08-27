import { redirect } from "react-router";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/redirect";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const organization =
    me.activeOrganization?.organization ?? me.organizations[0]?.organization ?? null;
  const scope = organization
    ? ({ kind: "org", orgSlug: organization.slug } as const)
    : ({ kind: "user", userId: me.user.id } as const);

  return redirect(`/backoffice/internals/${backofficeRouteScopePath(scope)}`);
}

export default function BackofficeInternalsRedirect() {
  return null;
}
