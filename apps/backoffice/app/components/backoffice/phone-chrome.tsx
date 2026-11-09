import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Button } from "@fragno-private/design-system/controls/button";
import { Icon } from "@fragno-private/design-system/icon";
import { BottomNavigation } from "@fragno-private/design-system/navigation/navigation";
import {
  BottomNavigationButton,
  BottomNavigationItem,
  SidebarNavigationItem,
  type NavigationItem,
} from "@fragno-private/design-system/navigation/navigation-item";
import { Sheet, SheetSection } from "@fragno-private/design-system/overlays/sheet";
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
import { BackofficeScopeSheetSections, currentScopeLabel } from "./scope-menu";
import type { BackofficeSections } from "./sidebar-nav";

/**
 * The shell's chrome on phones, in place of the top bar and sidebar: a slim header naming the
 * section and the workspace, which opens a sheet from the top to switch workspaces, and a bottom
 * tab bar, whose More opens a sheet from the bottom with everything else.
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
  // Remembers the location the sheet opened at, so following any link in it closes it.
  const [openSheet, setOpenSheet] = useState<{
    sheet: "workspace" | "menu";
    at: string;
  } | null>(null);
  const sheetOpen = (sheet: "workspace" | "menu") =>
    openSheet?.sheet === sheet && openSheet.at === location.key;
  const sheetOpenChange = (sheet: "workspace" | "menu") => (open: boolean) => {
    setOpenSheet(open ? { sheet, at: location.key } : null);
  };
  const projectOwner = resolvedScope && backofficeScopeProjectOwner(resolvedScope);
  const currentSection = sections.phone.all.find((item) => item.active) ?? null;
  const currentSectionInMenu =
    currentSection !== null && !sections.phone.tabs.some((tab) => tab.active);
  const workspaceLabel =
    me?.user && resolvedScope
      ? resolvedScope.kind === "project"
        ? `${currentScopeLabel(resolvedScope, me, administeredMember)} / ${resolvedScope.project.name}`
        : currentScopeLabel(resolvedScope, me, administeredMember)
      : null;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] pt-[env(safe-area-inset-top)] sm:hidden">
        <div className="flex h-14 items-center gap-3 pr-2 pl-4">
          <p className="min-w-0 flex-1 truncate text-base font-semibold">
            {currentSection?.label ?? "Leyway"}
          </p>
          {workspaceLabel === null ? (
            <BackofficeAppearanceMenu me={me} isLoading={isLoading} trigger="icon" />
          ) : (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen("workspace")}
              aria-label={`Switch workspace. Current context: ${workspaceLabel}`}
              onClick={() => {
                sheetOpenChange("workspace")(true);
              }}
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
        <BottomNavigation ariaLabel="Leyway">
          {sections.phone.tabs.map((item) => (
            <BottomNavigationItem key={item.label} item={item} />
          ))}
          <BottomNavigationButton
            label="More"
            icon="more-horizontal"
            active={currentSectionInMenu}
            expanded={sheetOpen("menu")}
            onClick={() => {
              sheetOpenChange("menu")(true);
            }}
          />
        </BottomNavigation>
      </div>

      {me?.user && resolvedScope ? (
        <Sheet
          side="top"
          open={sheetOpen("workspace")}
          onOpenChange={sheetOpenChange("workspace")}
          title="Switch workspace"
        >
          <BackofficeScopeSheetSections
            me={me}
            currentScope={resolvedScope}
            administeredMember={administeredMember}
          />
          {projectOwner ? (
            <StreamedBackofficeProjectMenu
              presentation="sheet"
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
        </Sheet>
      ) : null}

      <Sheet
        side="bottom"
        open={sheetOpen("menu")}
        onOpenChange={sheetOpenChange("menu")}
        title="Menu"
      >
        <PhoneMenu sections={sections.phone.all} me={me} isLoading={isLoading} />
      </Sheet>
    </>
  );
}

function PhoneMenu({
  sections,
  me,
  isLoading,
}: {
  sections: NavigationItem[];
  me: BackofficeMeData | null;
  isLoading: boolean;
}) {
  const { signOut, signingOut, error: signOutError } = useBackofficeSignOut();

  return (
    <>
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
