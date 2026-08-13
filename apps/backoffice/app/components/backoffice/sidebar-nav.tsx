import { Folder, MessagesSquare, Store, Workflow, type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { cn } from "@/lib/utils";

import { scopeSwitchPath } from "./scope-switch-path";

type PrimaryNavigationItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

// Section links carry the current scope so switching sections keeps the
// selected organisation/project instead of falling back to the default scope.
const navigationItemPath = (item: PrimaryNavigationItem, scope: BackofficeContextScope | null) =>
  scope ? scopeSwitchPath(item.to, scope) : item.to;

const PRIMARY_NAVIGATION: PrimaryNavigationItem[] = [
  {
    label: "Automations",
    to: "/backoffice/automations",
    icon: Workflow,
    isActive: (pathname) => pathname.startsWith("/backoffice/automations"),
  },
  {
    label: "Sessions",
    to: "/backoffice/sessions",
    icon: MessagesSquare,
    isActive: (pathname) => pathname.startsWith("/backoffice/sessions"),
  },
  {
    label: "Files",
    to: "/backoffice/files",
    icon: Folder,
    isActive: (pathname) => pathname.startsWith("/backoffice/files"),
  },
  {
    label: "Marketplace",
    to: "/backoffice/marketplace",
    icon: Store,
    isActive: (pathname) => pathname.startsWith("/backoffice/marketplace"),
  },
];

export function BackofficeSidebarNav({
  currentScope,
}: {
  currentScope: BackofficeContextScope | null;
}) {
  const location = useLocation();

  return (
    <aside className="sticky top-16 z-20 hidden h-[calc(100svh-4rem)] w-72 shrink-0 self-start border-r border-[color:var(--bo-border)] bg-[color:var(--bo-sidebar-bg)] min-[960px]:block">
      <nav aria-label="Backoffice" className="flex flex-col gap-2.5 px-3 py-4">
        {PRIMARY_NAVIGATION.map((item) => (
          <NavLink
            key={item.to}
            to={navigationItemPath(item, currentScope)}
            className={({ isActive }) => {
              const active = isActive || item.isActive(location.pathname);
              return cn(
                "flex min-h-11 items-center gap-3 rounded-[4px] border px-3 text-sm font-semibold text-[var(--bo-fg)] transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none",
                active
                  ? "border-[color:var(--bo-sidebar-item-active-border)] bg-[var(--bo-sidebar-item-active-bg)] shadow-[var(--bo-sidebar-item-active-shadow)]"
                  : "border-transparent hover:bg-[var(--bo-panel-2)]",
              );
            }}
          >
            <item.icon
              aria-hidden="true"
              className="size-4 shrink-0 text-[var(--bo-muted)]"
              strokeWidth={1.75}
            />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

export function BackofficeMobileNav({
  currentScope,
}: {
  currentScope: BackofficeContextScope | null;
}) {
  const location = useLocation();

  return (
    <nav aria-label="Backoffice" className="grid grid-cols-4">
      {PRIMARY_NAVIGATION.map((item) => (
        <NavLink
          key={item.to}
          to={navigationItemPath(item, currentScope)}
          className={({ isActive }) => {
            const active = isActive || item.isActive(location.pathname);
            return cn(
              "relative flex min-h-11 min-w-0 items-center justify-center border-b-2 px-1 text-[9px] font-semibold tracking-[0.1em] uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none focus-visible:ring-inset active:scale-[0.96]",
              active
                ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                : "border-transparent text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]",
            );
          }}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
