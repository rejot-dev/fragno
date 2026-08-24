import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/index";
import { marketplaceScopeTabPath } from "./scope";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organization = me.activeOrganization?.organization;
  if (organization) {
    return redirect(
      marketplaceScopeTabPath({
        kind: "org",
        organization,
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
