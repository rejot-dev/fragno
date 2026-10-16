import { redirect } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/mine";
import { marketplaceScopeTabPath } from "./scope";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const requestedOrganizationSlug = url.searchParams.get("organizationSlug")?.trim() || null;
  const requestedOrganization = requestedOrganizationSlug
    ? me.organizations.find(({ organization }) => organization.slug === requestedOrganizationSlug)
        ?.organization
    : null;
  if (requestedOrganizationSlug && !requestedOrganization) {
    throw new Response("Publisher organization was not found.", { status: 404 });
  }
  const organization = requestedOrganization ?? me.activeOrganization?.organization;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  const destination = new URL(
    marketplaceScopeTabPath(
      {
        kind: "org",
        organization,
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
