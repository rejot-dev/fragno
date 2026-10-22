import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { MobileNavigation, SidebarNavigation } from "@fragno-private/design-system/navigation";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { Select } from "@fragno-private/design-system/select";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";

import { MODE_LABELS } from "./modes";
import type { ShellData } from "./shell.server";

/**
 * The frame every signed-in area shares: the place, a switcher between places, who is signed in,
 * and the area's own navigation.
 */
export function AppShell({
  shell,
  items,
  ariaLabel,
  children,
}: {
  shell: ShellData;
  items: NavigationItem[];
  ariaLabel: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const { place, places, user } = shell;
  return (
    <div className="workspace-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="workspace-header sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-[var(--bo-border)] bg-[var(--bo-header-bg)] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link to={place.path} className="brand">
            <Icon name="book-open" className="size-5" />
            Bookkeeping
          </Link>
          <Select
            aria-label="Switch place"
            className="hidden w-64 sm:flex"
            density="compact"
            options={places.map(({ mode, name, path }) => ({
              label: `${MODE_LABELS[mode]}: ${name}`,
              value: path,
            }))}
            value={place.path}
            onValueChange={(path) => {
              if (path !== null && path !== place.path) {
                void navigate(path);
              }
            }}
          />
        </div>
        <ButtonLink variant="secondary" to="/account" className="max-w-48">
          <span className="truncate">{user.name}</span>
        </ButtonLink>
      </header>
      <div className="border-b border-[var(--bo-border)] min-[960px]:hidden">
        <MobileNavigation items={items} ariaLabel={ariaLabel} />
      </div>
      <div className="flex min-w-0">
        <SidebarNavigation
          items={items}
          ariaLabel={ariaLabel}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
        />
        <main id="main-content" className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
