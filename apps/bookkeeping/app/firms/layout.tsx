import { Outlet, useLocation } from "react-router";

import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { highestRole, ROLE_LABELS } from "../organizations/roles";
import { AppShell } from "../shell/app-shell";
import { loadShell } from "../shell/shell.server";
import type { Route } from "./+types/layout";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, organization, roles } = await requireOrganization(request, params.slug, "firm");
  const place = {
    mode: "firm",
    name: organization.name,
    path: organizationPath("firm", organization.slug),
  } as const;
  return await loadShell(user, place, ROLE_LABELS[highestRole(roles)]);
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

/** A firm's frame: its clients, and its team. */
export default function FirmLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const base = loaderData.place.path;
  return (
    <AppShell
      shell={loaderData}
      ariaLabel="Firm navigation"
      sections={[
        {
          label: null,
          items: [
            // Clients covers the dashboard and creating a client: every page but Members.
            {
              label: "Clients",
              to: base,
              icon: "briefcase",
              active: pathname !== `${base}/members`,
            },
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
      <Outlet />
    </AppShell>
  );
}
