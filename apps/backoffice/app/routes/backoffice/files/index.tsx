import { redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/index";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const returnTo = `${url.pathname}${url.search}`;
  const me = await getAuthMe(request, context);

  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(returnTo));
  }

  const orgId =
    me.activeOrganization?.organization.id ?? me.organizations?.[0]?.organization.id ?? null;

  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/backoffice/files/${orgId}`);
}

export default function BackofficeFilesIndex() {
  return null;
}
