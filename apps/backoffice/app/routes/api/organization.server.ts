import type { RouterContextProvider } from "react-router";

import { requireBackofficeMe } from "@/fragno/auth/auth-server";

export async function requireApiOrganization(
  request: Request,
  context: Readonly<RouterContextProvider>,
  organizationSlug: string | undefined,
) {
  if (!organizationSlug) {
    throw new Response("Missing organization slug", { status: 400 });
  }

  const me = await requireBackofficeMe(request, context);
  const organization = me.organizations.find(
    ({ organization }) => organization.slug === organizationSlug,
  )?.organization;
  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }
  return organization;
}
