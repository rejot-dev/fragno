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

  const organization = me.activeOrganization?.organization ?? null;
  const runtimeScope = organization
    ? ({ kind: "org", orgId: organization.id } as const)
    : ({ kind: "user", userId: me.user.id } as const);
  const routeScope = organization
    ? ({ kind: "org", orgSlug: organization.slug } as const)
    : ({ kind: "user", userId: me.user.id } as const);

  return redirect(
    durableHooksScopePath(routeScope, defaultDurableHooksObjectForScope(runtimeScope)),
  );
}

export default function BackofficeDurableHooksRedirect() {
  return null;
}
