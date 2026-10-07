import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { SidebarNavigation, MobileNavigation } from "@fragno-private/design-system/navigation";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";

import { requireSession } from "../lib/session.server";
import type { Route } from "./+types/dashboard-layout";

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireSession(request);
  return { user: session.user };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const items: NavigationItem[] = [
    { label: "Overview", to: "/dashboard", icon: "grid", active: pathname === "/dashboard" },
    {
      label: "Account",
      to: "/dashboard/account",
      icon: "user",
      active: pathname === "/dashboard/account",
    },
  ];
  return (
    <div className="workspace-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="workspace-header sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-[var(--bo-border)] bg-[var(--bo-header-bg)] px-4 sm:px-6">
        <Link to="/dashboard" className="brand">
          <Icon name="book-open" className="size-5" />
          Bookkeeping
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden text-xs text-[var(--bo-muted)] sm:block">Personal workspace</span>
          <ButtonLink variant="secondary" to="/dashboard/account" className="max-w-48">
            <span className="truncate">{loaderData.user.name}</span>
          </ButtonLink>
        </div>
      </header>
      <div className="border-b border-[var(--bo-border)] min-[960px]:hidden">
        <MobileNavigation items={items} ariaLabel="Workspace navigation" />
      </div>
      <div className="flex min-w-0">
        <SidebarNavigation
          items={items}
          ariaLabel="Workspace navigation"
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
        />
        <main id="main-content" className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl">
            <Outlet context={{ user: loaderData.user }} />
          </div>
        </main>
      </div>
    </div>
  );
}
