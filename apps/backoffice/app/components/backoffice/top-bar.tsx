import { Activity } from "lucide-react";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import { authClient } from "@/fragno/auth/auth-client";

import { BackofficeAccountMenu } from "./account-menu";
import { BackofficeProjectMenu, type BackofficeProjectOption } from "./project-menu";
import { BackofficeScopeMenu } from "./scope-menu";
import { BackofficeMobileNav } from "./sidebar-nav";
import { BackofficeThemeMenu } from "./theme-menu";

type BackofficeTopBarProps = {
  me: AuthMeData | null;
  currentScope: BackofficeContextScope | null;
  projects?: BackofficeProjectOption[];
  projectsError?: string | null;
  isLoading?: boolean;
  workflowDrawerOpen?: boolean;
  onWorkflowDrawerToggle?: () => void;
};

export function BackofficeTopBar({
  me,
  currentScope,
  projects = [],
  projectsError = null,
  isLoading,
  workflowDrawerOpen = false,
  onWorkflowDrawerToggle,
}: BackofficeTopBarProps) {
  const { data: meData, loading: meLoading } = authClient.useMe();
  const effectiveMe = meData === undefined ? me : meData;
  const sessionLoading = isLoading || (!effectiveMe && meLoading);

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-bg)]">
      <div className="flex h-16 items-stretch">
        <div className="flex min-w-0 flex-1 items-stretch min-[960px]:w-72 min-[960px]:flex-none min-[960px]:border-r min-[960px]:border-[color:var(--bo-border)]">
          <BackofficeScopeMenu me={effectiveMe} currentScope={currentScope} />
        </div>

        {currentScope?.kind === "org" || currentScope?.kind === "project" ? (
          <div className="flex min-w-0 flex-1 items-stretch min-[960px]:w-72 min-[960px]:flex-none min-[960px]:border-r min-[960px]:border-[color:var(--bo-border)]">
            <BackofficeProjectMenu
              orgId={currentScope.orgId}
              currentProjectId={currentScope.kind === "project" ? currentScope.projectId : null}
              projects={projects}
              projectsError={projectsError}
            />
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-stretch">
          {onWorkflowDrawerToggle ? (
            <button
              type="button"
              aria-label={workflowDrawerOpen ? "Close recent workflows" : "Open recent workflows"}
              aria-expanded={workflowDrawerOpen}
              title={`${workflowDrawerOpen ? "Close" : "Open"} recent workflows (⌘I)`}
              onClick={onWorkflowDrawerToggle}
              className={`flex w-14 shrink-0 cursor-pointer items-center justify-center border-l border-[color:var(--bo-border)] transition-[background-color,color] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset ${workflowDrawerOpen ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]" : "text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"}`}
            >
              <Activity className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <BackofficeThemeMenu />
        </div>

        <div className="flex shrink-0 items-center min-[960px]:border-l min-[960px]:border-[color:var(--bo-border)]">
          <BackofficeAccountMenu me={effectiveMe} isLoading={sessionLoading} />
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] min-[960px]:hidden">
        <BackofficeMobileNav currentScope={currentScope} />
      </div>
    </header>
  );
}
