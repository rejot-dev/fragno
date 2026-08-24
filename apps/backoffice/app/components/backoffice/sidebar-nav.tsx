import {
  Folder,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Store,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { NavLink, useLocation } from "react-router";

import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import { cn } from "@/lib/utils";

import { scopeSwitchPath } from "./scope-switch-path";

type PrimaryNavigationItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

// Section links carry the current scope so switching sections keeps the
// selected organization/project instead of falling back to the default scope.
const navigationItemPath = (item: PrimaryNavigationItem, scope: BackofficeRouteScope | null) =>
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
  collapsed,
  onCollapsedChange,
}: {
  currentScope: BackofficeRouteScope | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const location = useLocation();

  return (
    <aside
      className={`sticky top-16 z-20 hidden h-[calc(100svh-4rem)] shrink-0 self-start border-r border-[color:var(--bo-border)] bg-[color:var(--bo-sidebar-bg)] transition-[width] duration-150 ease-out min-[960px]:flex min-[960px]:flex-col ${collapsed ? "w-16" : "w-72"}`}
    >
      <nav aria-label="Backoffice" className="flex flex-col gap-2.5 px-2 py-4">
        {PRIMARY_NAVIGATION.map((item) => (
          <NavLink
            key={item.to}
            to={navigationItemPath(item, currentScope)}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) => {
              const active = isActive || item.isActive(location.pathname);
              return cn(
                "flex min-h-11 items-center rounded-[4px] border text-sm font-semibold text-[var(--bo-fg)] transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none",
                collapsed ? "justify-center px-0" : "gap-3 px-3",
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
            <span className={collapsed ? "sr-only" : undefined}>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <button
        type="button"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘B)`}
        onClick={() => {
          onCollapsedChange(!collapsed);
        }}
        className={cn(
          "mt-auto mb-3 flex size-9 shrink-0 items-center justify-center rounded-[4px] border border-transparent text-[var(--bo-muted)] transition-[background-color,border-color,color,transform] duration-150 ease-out hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.94]",
          collapsed ? "self-center" : "mr-3 self-end",
        )}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <PanelLeftClose className="size-4" strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
    </aside>
  );
}

export function BackofficeMobileNav({
  currentScope,
}: {
  currentScope: BackofficeRouteScope | null;
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
