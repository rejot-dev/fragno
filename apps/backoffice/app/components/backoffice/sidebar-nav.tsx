import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { IconName } from "@fragno-private/design-system/icon";
import { MobileNavigation, SidebarNavigation } from "@fragno-private/design-system/navigation";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { useLocation } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";

import { scopeSwitchPath } from "./scope-switch-path";

type PrimaryNavigationItem = {
  label: string;
  to: string;
  icon: IconName;
  isActive: (pathname: string) => boolean;
};

const PRIMARY_NAVIGATION: PrimaryNavigationItem[] = [
  {
    label: "Dashboard",
    to: "/backoffice/dashboard",
    icon: "grid",
    isActive: (pathname) => pathname.startsWith("/backoffice/dashboard"),
  },
  {
    label: "Integrations",
    to: "/backoffice/integrations",
    icon: "link",
    isActive: (pathname) => pathname.startsWith("/backoffice/integrations"),
  },
  {
    label: "Agents",
    to: "/backoffice/agents",
    icon: "message-square",
    isActive: (pathname) => pathname.startsWith("/backoffice/agents"),
  },
  {
    label: "Files",
    to: "/backoffice/files",
    icon: "folder",
    isActive: (pathname) => pathname.startsWith("/backoffice/files"),
  },
  {
    label: "Computers",
    to: "/backoffice/computers",
    icon: "monitor",
    isActive: (pathname) => pathname.startsWith("/backoffice/computers"),
  },
  {
    label: "Marketplace",
    to: "/backoffice/marketplace",
    icon: "shopping-bag",
    isActive: (pathname) => pathname.startsWith("/backoffice/marketplace"),
  },
];

type SidebarScope = BackofficeResolvedScope<Organization>;

// Section links carry the current scope so switching sections keeps the
// selected organization/project instead of falling back to the default scope.
function resolveNavigationItems(scope: SidebarScope | null, pathname: string): NavigationItem[] {
  const routeScope = scope ? backofficeRouteScopeFromResolvedScope(scope) : null;
  return PRIMARY_NAVIGATION.map((item) => ({
    label: item.label,
    to: routeScope ? scopeSwitchPath(item.to, routeScope) : item.to,
    icon: item.icon,
    active: item.isActive(pathname),
  }));
}

const SETTINGS_SECTIONS = [
  "/backoffice/settings",
  "/backoffice/organizations",
  "/backoffice/usage",
];

/**
 * Internals for system administrators, in whichever scope they are in, then Settings. Both stay
 * open across scope switches like every section. Settings appear in every scope that has them:
 * an organization's settings in its scopes, and in the user's own scopes theirs, which
 * list their organizations. System and another person's workspace have none; that workspace's
 * banner leads back to the organization.
 */
function resolveContextNavigationItems(
  scope: SidebarScope | null,
  me: BackofficeMeData | null,
  pathname: string,
): NavigationItem[] {
  if (!scope || !me) {
    return [];
  }
  const owner = backofficeScopeRootOwner(scope);
  const settingsPath =
    owner?.kind === "org"
      ? `/backoffice/organizations/${encodeURIComponent(owner.organization.slug)}`
      : owner?.kind === "user" && owner.userId === me.user.id
        ? "/backoffice/settings"
        : null;
  return [
    ...(me.user.role === "admin"
      ? [
          {
            label: "Internals",
            to: scopeSwitchPath(
              "/backoffice/internals",
              backofficeRouteScopeFromResolvedScope(scope),
            ),
            icon: "shield" as const,
            active: pathname.startsWith("/backoffice/internals"),
          },
        ]
      : []),
    ...(settingsPath
      ? [
          {
            label: "Settings",
            to: settingsPath,
            icon: "settings" as const,
            active: SETTINGS_SECTIONS.some(
              (section) => pathname === section || pathname.startsWith(`${section}/`),
            ),
          },
        ]
      : []),
  ];
}

export function BackofficeSidebarNav({
  currentScope,
  me,
  collapsed,
  onCollapsedChange,
}: {
  currentScope: SidebarScope | null;
  me: BackofficeMeData | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const location = useLocation();

  return (
    <SidebarNavigation
      items={resolveNavigationItems(currentScope, location.pathname)}
      secondaryItems={resolveContextNavigationItems(currentScope, me, location.pathname)}
      ariaLabel="Backoffice"
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    />
  );
}

export function BackofficeMobileNav({
  currentScope,
  me,
}: {
  currentScope: SidebarScope | null;
  me: BackofficeMeData | null;
}) {
  const location = useLocation();

  return (
    <MobileNavigation
      items={[
        ...resolveNavigationItems(currentScope, location.pathname),
        ...resolveContextNavigationItems(currentScope, me, location.pathname),
      ]}
      ariaLabel="Backoffice"
    />
  );
}
