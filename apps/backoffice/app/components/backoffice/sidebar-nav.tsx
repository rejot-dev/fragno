import type { IconName } from "@fragno-private/design-system/icon";
import { MobileNavigation, SidebarNavigation } from "@fragno-private/design-system/navigation";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { useLocation } from "react-router";

import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";

import { scopeSwitchPath } from "./scope-switch-path";

type PrimaryNavigationItem = {
  label: string;
  to: string;
  icon: IconName;
  isActive: (pathname: string) => boolean;
};

const PRIMARY_NAVIGATION: PrimaryNavigationItem[] = [
  {
    label: "Automations",
    to: "/backoffice/automations",
    icon: "share-2",
    isActive: (pathname) => pathname.startsWith("/backoffice/automations"),
  },
  {
    label: "Sessions",
    to: "/backoffice/sessions",
    icon: "message-square",
    isActive: (pathname) => pathname.startsWith("/backoffice/sessions"),
  },
  {
    label: "Files",
    to: "/backoffice/files",
    icon: "folder",
    isActive: (pathname) => pathname.startsWith("/backoffice/files"),
  },
  {
    label: "Marketplace",
    to: "/backoffice/marketplace",
    icon: "shopping-bag",
    isActive: (pathname) => pathname.startsWith("/backoffice/marketplace"),
  },
];

// Section links carry the current scope so switching sections keeps the
// selected organization/project instead of falling back to the default scope.
function resolveNavigationItems(
  scope: BackofficeRouteScope | null,
  pathname: string,
): NavigationItem[] {
  return PRIMARY_NAVIGATION.map((item) => ({
    label: item.label,
    to: scope ? scopeSwitchPath(item.to, scope) : item.to,
    icon: item.icon,
    active: item.isActive(pathname),
  }));
}

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
    <SidebarNavigation
      items={resolveNavigationItems(currentScope, location.pathname)}
      ariaLabel="Backoffice"
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    />
  );
}

export function BackofficeMobileNav({
  currentScope,
}: {
  currentScope: BackofficeRouteScope | null;
}) {
  const location = useLocation();

  return (
    <MobileNavigation
      items={resolveNavigationItems(currentScope, location.pathname)}
      ariaLabel="Backoffice"
    />
  );
}
