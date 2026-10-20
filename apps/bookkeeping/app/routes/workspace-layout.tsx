import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { SidebarNavigation, MobileNavigation } from "@fragno-private/design-system/navigation";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { Select } from "@fragno-private/design-system/select";
import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";

import type { SessionUser } from "../../workers/auth";
import type { Workspace, WorkspaceRole } from "../../workers/workspaces";
import { requireWorkspace } from "../lib/workspace.server";
import type { Route } from "./+types/workspace-layout";

/** What every workspace page receives from the layout. */
export type WorkspaceOutletContext = {
  user: SessionUser;
  workspace: Workspace;
  roles: WorkspaceRole[];
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, membership } = await requireWorkspace(request, params.slug);
  const memberships = await env.WORKSPACES.getByName("workspaces").listMemberships(
    user.backofficeUserId,
  );
  return {
    user,
    workspace: membership.workspace,
    roles: membership.roles,
    workspaces: memberships.map(({ workspace }) => ({
      label: workspace.name,
      value: workspace.slug,
    })),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, workspace, roles } = loaderData;
  const base = `/w/${workspace.slug}`;
  const items: NavigationItem[] = [
    { label: "Overview", to: base, icon: "grid", active: pathname === base },
    {
      label: "Members",
      to: `${base}/members`,
      icon: "users",
      active: pathname === `${base}/members`,
    },
    {
      label: "Account",
      to: `${base}/account`,
      icon: "user",
      active: pathname === `${base}/account`,
    },
  ];
  return (
    <div className="workspace-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="workspace-header sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-[var(--bo-border)] bg-[var(--bo-header-bg)] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link to={base} className="brand">
            <Icon name="book-open" className="size-5" />
            Bookkeeping
          </Link>
          <Select
            aria-label="Workspace"
            className="hidden w-56 sm:flex"
            density="compact"
            options={loaderData.workspaces}
            value={workspace.slug}
            onValueChange={(slug) => {
              if (slug !== null && slug !== workspace.slug) {
                void navigate(`/w/${slug}`);
              }
            }}
          />
        </div>
        <ButtonLink variant="secondary" to={`${base}/account`} className="max-w-48">
          <span className="truncate">{user.name || user.email}</span>
        </ButtonLink>
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
            <Outlet context={{ user, workspace, roles } satisfies WorkspaceOutletContext} />
          </div>
        </main>
      </div>
    </div>
  );
}
