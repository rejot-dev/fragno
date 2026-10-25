import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";
import { Outlet, useLocation } from "react-router";

import type { SessionUser } from "../../workers/auth/auth";
import type { Organization } from "../../workers/directory/directory";
import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { highestRole, ROLE_LABELS } from "../organizations/roles";
import { AppShell } from "../shell/app-shell";
import { loadShell } from "../shell/shell.server";
import type { Route } from "./+types/layout";

/** What every page of a client's workspace receives from the layout. */
export type ClientOutletContext = {
  user: SessionUser;
  client: Organization;
  roles: OrganizationRole[];
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, organization, roles } = await requireOrganization(request, params.slug, "client");
  const place = {
    mode: "client",
    name: organization.name,
    path: organizationPath("client", organization.slug),
  } as const;
  return {
    ...(await loadShell(user, place, ROLE_LABELS[highestRole(roles)])),
    context: { user, client: organization, roles } satisfies ClientOutletContext,
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

/** A client's workspace: its administrations, and its team. */
export default function ClientLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const base = loaderData.place.path;
  return (
    <AppShell
      shell={loaderData}
      ariaLabel="Workspace navigation"
      sections={[
        {
          label: null,
          items: [
            { label: "Overview", to: base, icon: "grid", active: pathname !== `${base}/members` },
            {
              label: "Members",
              to: `${base}/members`,
              icon: "users",
              active: pathname === `${base}/members`,
            },
          ],
        },
      ]}
    >
      <Outlet context={loaderData.context} />
    </AppShell>
  );
}
