import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/index";
import { marketplaceScopeTabPath } from "./scope";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organization = me.activeOrganization?.organization ?? me.organizations[0]?.organization;
  if (organization) {
    return redirect(
      marketplaceScopeTabPath({
        kind: "org",
        orgId: organization.id,
        label: organization.name ?? organization.id,
      }),
    );
  }

  return redirect(
    marketplaceScopeTabPath({
      kind: "user",
      userId: me.user.id,
      label: me.user.email ?? me.user.id,
    }),
  );
}

export default function BackofficeMarketplaceIndex() {
  return null;
}
