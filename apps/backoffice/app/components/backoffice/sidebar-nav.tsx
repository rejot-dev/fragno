import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { IconName } from "@fragno-private/design-system/icon";
import { MobileNavigation, SidebarNavigation } from "@fragno-private/design-system/navigation";
import type { NavigationItem } from "@fragno-private/design-system/navigation-item";
import { useState } from "react";
import { useLocation } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { mainPiAgentPath } from "@/routes/backoffice/agents/path";

import { scopeSwitchPath } from "./scope-switch-path";

type PrimaryNavigationItem = {
  label: string;
  to: string;
  icon: IconName;
  isActive: (pathname: string) => boolean;
  /** Whether phones give it a tab of its own; the others are in the phone menu. */
  phoneTab: boolean;
  /** Where phones start it in a scope, when not where wider screens do. */
  phoneStart: ((scope: BackofficeRouteScope) => string) | null;
};

const PRIMARY_NAVIGATION: PrimaryNavigationItem[] = [
  {
    label: "Dashboard",
    to: "/backoffice/dashboard",
    icon: "grid",
    isActive: (pathname) => pathname.startsWith("/backoffice/dashboard"),
    phoneTab: true,
    phoneStart: null,
  },
  {
    label: "Integrations",
    to: "/backoffice/integrations",
    icon: "link",
    isActive: (pathname) => pathname.startsWith("/backoffice/integrations"),
    phoneTab: false,
    phoneStart: null,
  },
  {
    label: "Agents",
    to: "/backoffice/agents",
    icon: "message-square",
    isActive: (pathname) => pathname.startsWith("/backoffice/agents"),
    phoneTab: true,
    phoneStart: mainPiAgentPath,
  },
  {
    label: "Files",
    to: "/backoffice/files",
    icon: "folder",
    isActive: (pathname) => pathname.startsWith("/backoffice/files"),
    phoneTab: true,
    phoneStart: null,
  },
  {
    label: "Computers",
    to: "/backoffice/computers",
    icon: "monitor",
    isActive: (pathname) => pathname.startsWith("/backoffice/computers"),
    phoneTab: false,
    phoneStart: null,
  },
  {
    label: "Marketplace",
    to: "/backoffice/marketplace",
    icon: "shopping-bag",
    isActive: (pathname) => pathname.startsWith("/backoffice/marketplace"),
    phoneTab: false,
    phoneStart: null,
  },
];

type SidebarScope = BackofficeResolvedScope<Organization>;

type PrimarySection = { link: NavigationItem; phoneTab: boolean; phoneStart: string };

// Section links carry the current scope so switching sections keeps the
// selected organization/project instead of falling back to the default scope.
function resolvePrimarySections(scope: SidebarScope | null, pathname: string): PrimarySection[] {
  const routeScope = scope ? backofficeRouteScopeFromResolvedScope(scope) : null;
  return PRIMARY_NAVIGATION.map((item) => {
    const start = routeScope ? scopeSwitchPath(item.to, routeScope) : item.to;
    return {
      link: { label: item.label, to: start, icon: item.icon, active: item.isActive(pathname) },
      phoneTab: item.phoneTab,
      phoneStart: routeScope && item.phoneStart ? item.phoneStart(routeScope) : start,
    };
  });
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
  sections,
  collapsed,
  onCollapsedChange,
}: {
  sections: BackofficeSections;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  return (
    <SidebarNavigation
      sections={[{ label: null, items: sections.primary }]}
      secondaryItems={sections.context}
      ariaLabel="Backoffice"
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    />
  );
}

export function BackofficeMobileNav({ sections }: { sections: BackofficeSections }) {
  return (
    <MobileNavigation items={[...sections.primary, ...sections.context]} ariaLabel="Backoffice" />
  );
}

export type BackofficeSections = {
  primary: NavigationItem[];
  /** Internals and Settings, after the primary sections. */
  context: NavigationItem[];
  /** Phones' sections, some of which start elsewhere. */
  phone: {
    /** The primary sections phones give a tab of their own. */
    tabs: NavigationItem[];
    all: NavigationItem[];
  };
};

/**
 * Every section in the sidebar's order. Like a native app's tabs, a section's link returns to where
 * it was left, and the current section's link returns to its start. The shell calls this once and
 * passes the sections to every navigation, so they share where each section was left.
 */
export function useBackofficeSections(
  currentScope: SidebarScope | null,
  me: BackofficeMeData | null,
): BackofficeSections {
  const location = useLocation();
  const primary = resolvePrimarySections(currentScope, location.pathname);
  const context = resolveContextNavigationItems(currentScope, me, location.pathname);
  // Where each section was left, by its link. Links carry the scope, so each scope remembers its
  // own. The memory lasts until a reload.
  const [lastVisited, setLastVisited] = useState<ReadonlyMap<string, string>>(new Map());
  const currentSection = [...primary.map(({ link }) => link), ...context].find(
    (item) => item.active,
  );
  const here = `${location.pathname}${location.search}`;
  if (currentSection !== undefined && lastVisited.get(currentSection.to) !== here) {
    setLastVisited(new Map(lastVisited).set(currentSection.to, here));
  }
  const resume = (item: NavigationItem, start: string): NavigationItem => ({
    ...item,
    to: item.active ? start : (lastVisited.get(item.to) ?? start),
  });
  const resumedContext = context.map((item) => resume(item, item.to));
  const phonePrimary = primary.map((section) => ({
    ...section,
    link: resume(section.link, section.phoneStart),
  }));
  return {
    primary: primary.map(({ link }) => resume(link, link.to)),
    context: resumedContext,
    phone: {
      tabs: phonePrimary.filter((section) => section.phoneTab).map(({ link }) => link),
      all: [...phonePrimary.map(({ link }) => link), ...resumedContext],
    },
  };
}
