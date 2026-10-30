import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Button } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { BottomNavigation } from "@fragno-private/design-system/navigation";
import {
  BottomNavigationButton,
  BottomNavigationItem,
  SidebarNavigationItem,
  type NavigationItem,
} from "@fragno-private/design-system/navigation-item";
import { Sheet, SheetSection } from "@fragno-private/design-system/sheet";
import { useState } from "react";
import { useLocation } from "react-router";

import {
  type BackofficeNamedProject,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { AdministeredMember, BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { useBackofficeSignOut } from "@/fragno/auth/use-backoffice-sign-out";
import type { AutomationProjectList } from "@/fragno/automation/project-list";

import { BackofficeAppearanceMenu } from "./appearance-menu";
import { StreamedBackofficeProjectMenu } from "./project-menu";
import { BackofficeScopeMenu, currentScopeLabel } from "./scope-menu";
import type { BackofficeSections } from "./sidebar-nav";

/**
 * The shell's chrome on phones, in place of the top bar and sidebar: a slim header naming the
 * section and the workspace, a bottom tab bar, and a menu sheet with everything else.
 */
export function BackofficePhoneChrome({
  sections,
  me,
  resolvedScope,
  administeredMember,
  projectList,
  isLoading,
}: {
  sections: BackofficeSections;
  me: BackofficeMeData | null;
  resolvedScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> | null;
  administeredMember: AdministeredMember | null;
  projectList: Promise<AutomationProjectList> | null;
  isLoading: boolean;
}) {
  const location = useLocation();
  // Remembers the location it opened at, so following any link in it closes it.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const menuOpen = menuOpenAt === location.key;
  const allSections = [...sections.primary, ...sections.context];
  const currentSection = allSections.find((item) => item.active) ?? null;
  const currentSectionInMenu =
    currentSection !== null && !sections.phoneTabs.some((tab) => tab.active);
  const workspaceLabel =
    me?.user && resolvedScope
      ? resolvedScope.kind === "project"
        ? `${currentScopeLabel(resolvedScope, me, administeredMember)} / ${resolvedScope.project.name}`
        : currentScopeLabel(resolvedScope, me, administeredMember)
      : null;
  const openMenu = () => {
    setMenuOpenAt(location.key);
  };

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] pt-[env(safe-area-inset-top)] sm:hidden">
        <div className="flex h-14 items-center gap-3 pr-2 pl-4">
          <p className="min-w-0 flex-1 truncate text-base font-semibold">
            {currentSection?.label ?? "Backoffice"}
          </p>
          {workspaceLabel === null ? (
            <BackofficeAppearanceMenu me={me} isLoading={isLoading} trigger="icon" />
          ) : (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              aria-label={`Open menu. Current context: ${workspaceLabel}`}
              onClick={openMenu}
              className="flex min-h-10 max-w-[65%] min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-[var(--bo-selected-bg)] px-3.5 text-xs font-semibold text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)] transition-[scale] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
            >
              <span className="truncate">{workspaceLabel}</span>
              <Icon name="chevron-down" className="size-3.5 shrink-0 text-[var(--bo-muted-2)]" />
            </button>
          )}
        </div>
      </header>

      {/* Pages keep clear of it through --bo-shell-bottom. */}
      <div className="sm:hidden">
        <BottomNavigation ariaLabel="Backoffice">
          {sections.phoneTabs.map((item) => (
            <BottomNavigationItem key={item.label} item={item} />
          ))}
          <BottomNavigationButton
            label="More"
            icon="more-horizontal"
            active={currentSectionInMenu}
            expanded={menuOpen}
            onClick={openMenu}
          />
        </BottomNavigation>
      </div>

      <Sheet
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpenAt(open ? location.key : null);
        }}
        title="Menu"
      >
        <PhoneMenu
          sections={allSections}
          me={me}
          resolvedScope={resolvedScope}
          administeredMember={administeredMember}
          projectList={projectList}
          isLoading={isLoading}
        />
      </Sheet>
    </>
  );
}

function PhoneMenu({
  sections,
  me,
  resolvedScope,
  administeredMember,
  projectList,
  isLoading,
}: {
  sections: NavigationItem[];
  me: BackofficeMeData | null;
  resolvedScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> | null;
  administeredMember: AdministeredMember | null;
  projectList: Promise<AutomationProjectList> | null;
  isLoading: boolean;
}) {
  const { signOut, signingOut, error: signOutError } = useBackofficeSignOut();
  const projectOwner = resolvedScope && backofficeScopeProjectOwner(resolvedScope);

  return (
    <>
      <SheetSection label="Workspace">
        <div className="flex flex-col divide-y divide-[color:var(--bo-border)] rounded-[6px] border border-[color:var(--bo-border)]">
          <BackofficeScopeMenu
            me={me}
            currentScope={resolvedScope}
            administeredMember={administeredMember}
            sidebarCollapsed={false}
          />
          {resolvedScope && projectOwner ? (
            <StreamedBackofficeProjectMenu
              owner={backofficeRouteScopeFromResolvedScope(projectOwner)}
              administeredMember={administeredMember}
              currentProject={
                resolvedScope.kind === "project"
                  ? { slug: resolvedScope.project.slug, label: resolvedScope.project.name }
                  : null
              }
              projectList={projectList}
            />
          ) : null}
        </div>
      </SheetSection>

      <SheetSection label="Sections">
        <nav aria-label="All sections" className="grid grid-cols-2 gap-2">
          {sections.map((item) => (
            <SidebarNavigationItem key={item.label} item={item} collapsed={false} />
          ))}
        </nav>
      </SheetSection>

      <SheetSection label="Preferences">
        <div className="rounded-[6px] border border-[color:var(--bo-border)]">
          <BackofficeAppearanceMenu me={me} isLoading={isLoading} trigger="row" />
        </div>
        <Button variant="ghost" disabled={signingOut} onClick={signOut} className="justify-start">
          <Icon name="log-out" className="size-4 text-[var(--bo-muted)]" strokeWidth={1.75} />
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
        {signOutError ? (
          <p role="alert" className="text-xs text-[var(--bo-failed)]">
            {signOutError instanceof Error ? signOutError.message : "Unable to sign out."}
          </p>
        ) : null}
      </SheetSection>
    </>
  );
}
