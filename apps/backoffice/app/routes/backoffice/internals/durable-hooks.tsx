import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/durable-hooks";
import { defaultDurableHooksObjectForScope, durableHooksScopePath } from "./durable-hooks-scope";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const orgId =
    me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id ?? null;
  const scope = orgId
    ? ({ kind: "org", orgId } as const)
    : ({ kind: "user", userId: me.user.id } as const);

  return redirect(durableHooksScopePath(scope, defaultDurableHooksObjectForScope(scope)));
}

export default function BackofficeDurableHooksRedirect() {
  return null;
}
