import { Outlet, useLocation } from "react-router";

import { requireOperator } from "../organizations/access.server";
import { highestRole, ROLE_LABELS } from "../organizations/roles";
import { AppShell } from "../shell/app-shell";
import { loadShell } from "../shell/shell.server";
import type { Route } from "./+types/layout";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, organization, roles } = await requireOperator(request);
  const place = { mode: "operator", name: organization.name, path: "/operator" } as const;
  return await loadShell(user, place, ROLE_LABELS[highestRole(roles)]);
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

/** Where operators create firms and find them again. */
export default function OperatorLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  return (
    <AppShell
      shell={loaderData}
      ariaLabel="Operator navigation"
      sections={[
        {
          label: null,
          items: [
            {
              label: "Firms",
              to: "/operator",
              icon: "briefcase",
              active: pathname === "/operator",
            },
            {
              label: "New firm",
              to: "/operator/firms/new",
              icon: "plus-circle",
              active: pathname === "/operator/firms/new",
            },
            {
              label: "Operators",
              to: "/operator/members",
              icon: "users",
              active: pathname === "/operator/members",
            },
          ],
        },
      ]}
    >
      <Outlet />
    </AppShell>
  );
}
