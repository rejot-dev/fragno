import type { RouterContextProvider } from "react-router";

import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import { throwBackofficeOrganizationNotFound } from "@/routes/backoffice/route-errors";

/** Resolves an Upload browser-route organization slug to its internal organization record. */
export async function requireUploadRouteOrganization(
  request: Request,
  context: Readonly<RouterContextProvider>,
  organizationSlug: string | undefined,
) {
  if (!organizationSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await requireBackofficeMe(request, context);
  const organization = me.organizations.find(
    (entry) => entry.organization.slug === organizationSlug,
  )?.organization;
  if (!organization) {
    throwBackofficeOrganizationNotFound(organizationSlug);
  }
  return { me, organization };
}
