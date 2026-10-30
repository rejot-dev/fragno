import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  type BackofficeNamedProject,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { AdministeredMember, BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import type { AutomationProjectList } from "@/fragno/automation/project-list";

import { AGENT_DRAWER_ID, preloadAgentDrawer } from "./agent-drawer";
import { BackofficeAppearanceMenu } from "./appearance-menu";
import { BackofficePresenceIndicator } from "./presence-indicator";
import { StreamedBackofficeProjectMenu } from "./project-menu";
import { BackofficeScopeMenu } from "./scope-menu";
import { BackofficeMobileNav, type BackofficeSections } from "./sidebar-nav";

type BackofficeTopBarProps = {
  sections: BackofficeSections;
  me: BackofficeMeData | null;
  resolvedScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> | null;
  administeredMember: AdministeredMember | null;
  projectList: Promise<AutomationProjectList> | null;
  isLoading?: boolean;
  sidebarCollapsed: boolean;
  agentDrawerOpen?: boolean;
  onAgentDrawerToggle?: () => void;
};

export function BackofficeTopBar({
  sections,
  me,
  resolvedScope,
  administeredMember,
  projectList,
  isLoading,
  sidebarCollapsed,
  agentDrawerOpen = false,
  onAgentDrawerToggle,
}: BackofficeTopBarProps) {
  const projectOwner = resolvedScope && backofficeScopeProjectOwner(resolvedScope);

  return (
    // Phones get BackofficePhoneChrome instead.
    <header className="sticky top-0 z-30 hidden border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] pt-[env(safe-area-inset-top)] sm:block">
      <div className="flex h-16 items-stretch">
        {/* Tracks the sidebar's width below it, including its collapse transition. */}
        <div
          className={`flex min-w-0 flex-1 items-stretch transition-[width] duration-150 ease-out min-[960px]:flex-none min-[960px]:border-r min-[960px]:border-[color:var(--bo-border)] ${sidebarCollapsed ? "min-[960px]:w-16" : "min-[960px]:w-72"}`}
        >
          <BackofficeScopeMenu
            me={me}
            currentScope={resolvedScope}
            administeredMember={administeredMember}
            sidebarCollapsed={sidebarCollapsed}
          />
        </div>

        {resolvedScope && projectOwner ? (
          <div className="flex min-w-0 flex-1 items-stretch min-[960px]:w-72 min-[960px]:flex-none min-[960px]:border-r min-[960px]:border-[color:var(--bo-border)]">
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
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-stretch">
          {me?.activeOrganizationId ? (
            // Keyed so switching organizations drops the previous organization's members.
            <BackofficePresenceIndicator key={me.activeOrganizationId} />
          ) : null}
          <div className="flex shrink-0 items-center min-[960px]:border-l min-[960px]:border-[color:var(--bo-border)]">
            <BackofficeAppearanceMenu me={me} isLoading={isLoading} trigger="icon" />
          </div>
        </div>

        {onAgentDrawerToggle ? (
          <button
            type="button"
            aria-label={agentDrawerOpen ? "Close agent" : "Open agent"}
            aria-expanded={agentDrawerOpen}
            aria-controls={AGENT_DRAWER_ID}
            aria-keyshortcuts="Meta+I Control+I"
            title={`${agentDrawerOpen ? "Close" : "Open"} agent (⌘I)`}
            onClick={onAgentDrawerToggle}
            onPointerEnter={preloadAgentDrawer}
            onFocus={preloadAgentDrawer}
            className={`flex w-16 shrink-0 cursor-pointer items-center justify-center border-l border-[color:var(--bo-border)] transition-[background-color,color] duration-150 ease-out outline-none ${agentDrawerOpen ? "bg-[color:var(--bo-sidebar-bg)]" : "hover:bg-[var(--bo-panel-2)]"}`}
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--bo-accent)_-40%,var(--bo-fg)_65%)] text-xs leading-none font-bold tracking-tight text-[var(--bo-panel)] shadow-md ring-4 inset-shadow-[0_1px_0_rgb(255_255_255/0.25)] ring-[color:var(--bo-fg)]/15">
              A
              <svg
                viewBox="0 0 8 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                className="ml-px h-[0.78em] w-auto"
                aria-hidden="true"
              >
                <path d="M1.5 1.5c1.5 0 2.5.5 2.5 2 0-1.5 1-2 2.5-2M4 3.5v9M1.5 14.5c1.5 0 2.5-.5 2.5-2 0 1.5 1 2 2.5 2" />
              </svg>
            </span>
          </button>
        ) : null}
      </div>

      <div className="border-t border-[color:var(--bo-border)] min-[960px]:hidden">
        <BackofficeMobileNav sections={sections} />
      </div>
    </header>
  );
}
