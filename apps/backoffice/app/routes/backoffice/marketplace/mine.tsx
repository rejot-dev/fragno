import { redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/mine";
import { marketplaceScopeTabPath } from "./scope";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const requestedOrganizationId = url.searchParams.get("organizationId")?.trim() || null;
  const requestedOrganization = requestedOrganizationId
    ? me.organizations.find(({ organization }) => organization.id === requestedOrganizationId)
        ?.organization
    : null;
  if (requestedOrganizationId && !requestedOrganization) {
    throw new Response("Publisher organisation was not found.", { status: 404 });
  }
  const organization =
    requestedOrganization ??
    me.activeOrganization?.organization ??
    me.organizations[0]?.organization;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  const destination = new URL(
    marketplaceScopeTabPath(
      {
        kind: "org",
        orgId: organization.id,
        label: organization.name ?? organization.id,
      },
      "my-listings",
    ),
    request.url,
  );
  for (const name of ["status", "cursor"] as const) {
    const value = url.searchParams.get(name);
    if (value) {
      destination.searchParams.set(name, value);
    }
  }
  return redirect(`${destination.pathname}${destination.search}`);
}

export default function BackofficeMarketplaceMineRedirect() {
  return null;
}
