import { Outlet, useLocation } from "react-router";

import { AppShell } from "../shell/app-shell";
import { loadShell, OPERATOR_PLACE } from "../shell/shell.server";
import type { Route } from "./+types/layout";
import { requireOperator } from "./operator.server";

export async function loader({ request }: Route.LoaderArgs) {
  return await loadShell(await requireOperator(request), OPERATOR_PLACE, "Operator");
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
      items={[
        { label: "Firms", to: "/operator", icon: "briefcase", active: pathname === "/operator" },
        {
          label: "New firm",
          to: "/operator/firms/new",
          icon: "plus-circle",
          active: pathname === "/operator/firms/new",
        },
      ]}
    >
      <Outlet />
    </AppShell>
  );
}
