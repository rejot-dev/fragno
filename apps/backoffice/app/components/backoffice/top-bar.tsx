import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Icon } from "@fragno-private/design-system/icon";
import { Link, useLocation } from "react-router";

import {
  type BackofficeNamedProject,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { AdministeredMember, BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import type { AutomationProjectList } from "@/fragno/automation/project-list";
import { integrationsConnectPath } from "@/routes/backoffice/integrations/connection-paths";

import { AGENT_DRAWER_ID, preloadAgentDrawer } from "./agent-drawer";
import { AgentMark } from "./agent-mark";
import { BackofficeAppearanceMenu } from "./appearance-menu";
import { BackofficePresenceIndicator } from "./presence-indicator";
import { StreamedBackofficeProjectMenu } from "./project-menu";
import { BackofficeScopeMenu } from "./scope-menu";
import { type ScopeProbe, StreamedScopeProbe } from "./scope-probe";

type BackofficeTopBarProps = {
  me: BackofficeMeData | null;
  resolvedScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> | null;
  administeredMember: AdministeredMember | null;
  projectList: Promise<AutomationProjectList> | null;
  scopeProbe: Promise<ScopeProbe> | null;
  isLoading?: boolean;
  sidebarCollapsed: boolean;
  agentDrawerOpen?: boolean;
  onAgentDrawerToggle?: () => void;
};

// The Connect wizard opens from every page of a scope, so connecting a source is always one click
// away. On the wizard it stays as the current place, and leads back to choosing a source.
function ConnectButton({
  scope,
}: {
  scope: BackofficeResolvedScope<Organization, BackofficeNamedProject>;
}) {
  const location = useLocation();
  const to = integrationsConnectPath(scope);
  const current = location.pathname === to;
  return (
    <Link
      to={to}
      aria-label="Connect"
      aria-current={current ? "page" : undefined}
      title="Connect a source"
      className={`group flex shrink-0 cursor-pointer items-center gap-2 border-l border-[color:var(--bo-border)] px-4 text-sm font-semibold text-[var(--bo-fg)] transition-[background-color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset ${current ? "bg-[color:var(--bo-sidebar-bg)]" : "hover:bg-[var(--bo-panel-2)]"}`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center transition-colors duration-150 ease-out group-hover:text-[var(--bo-fg)] ${current ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted)]"}`}
      >
        <Icon name="plus" className="size-4" strokeWidth={1.75} />
      </span>
      <span className="hidden pr-2 sm:inline">Connect</span>
    </Link>
  );
}

export function BackofficeTopBar({
  me,
  resolvedScope,
  administeredMember,
  projectList,
  scopeProbe,
  isLoading,
  sidebarCollapsed,
  agentDrawerOpen = false,
  onAgentDrawerToggle,
}: BackofficeTopBarProps) {
  const projectOwner = resolvedScope && backofficeScopeProjectOwner(resolvedScope);

  return (
    // Phones get BackofficePhoneHeader instead.
    <header className="desktop:block sticky top-0 z-30 hidden border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] pt-[env(safe-area-inset-top)]">
      <div className="flex h-16 items-stretch">
        {/* Tracks the sidebar's width below it, including its collapse transition. */}
        <div
          className={`flex min-w-0 flex-none items-stretch border-r border-[color:var(--bo-border)] transition-[width] duration-150 ease-out ${sidebarCollapsed ? "w-16" : "w-72"}`}
        >
          <BackofficeScopeMenu
            me={me}
            currentScope={resolvedScope}
            administeredMember={administeredMember}
            sidebarCollapsed={sidebarCollapsed}
          />
        </div>

        {resolvedScope && projectOwner ? (
          // On the narrowest top bars it shrinks so the controls on the right keep their room.
          <div className="flex max-w-72 min-w-0 flex-1 items-stretch border-r border-[color:var(--bo-border)]">
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
          <StreamedScopeProbe scopeProbe={scopeProbe} presentation="bar" />
          {resolvedScope ? <ConnectButton scope={resolvedScope} /> : null}
          {me?.activeOrganizationId ? (
            // Keyed so switching organizations drops the previous organization's members.
            <BackofficePresenceIndicator key={me.activeOrganizationId} />
          ) : null}
          <div className="flex shrink-0 items-center border-l border-[color:var(--bo-border)]">
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
    </header>
  );
}
