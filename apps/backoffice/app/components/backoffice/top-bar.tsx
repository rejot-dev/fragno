import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  type BackofficeNamedProject,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { AdministeredMember, BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import type { AutomationProjectList } from "@/fragno/automation/project-list";

import { AGENT_DRAWER_ID, preloadAgentDrawer } from "./agent-drawer";
import { AgentMark } from "./agent-mark";
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
              presentation="menu"
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
            <AgentMark />
          </button>
        ) : null}
      </div>

      <div className="border-t border-[color:var(--bo-border)] min-[960px]:hidden">
        <BackofficeMobileNav sections={sections} />
      </div>
    </header>
  );
}
