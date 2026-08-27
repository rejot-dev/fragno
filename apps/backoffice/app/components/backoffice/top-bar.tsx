import { Activity } from "lucide-react";
import { Suspense, use } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import type { AutomationCollectionSourceState } from "@/components/backoffice/current-context-state";
import { ClientOnly } from "@/components/client-only";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationProjects } from "@/fragno/automation/tanstack/use-automation-projects";

import { BackofficeAccountMenu } from "./account-menu";
import { BackofficeProjectMenu, type BackofficeProjectOption } from "./project-menu";
import { BackofficeScopeMenu } from "./scope-menu";
import { BackofficeMobileNav } from "./sidebar-nav";
import { BackofficeThemeMenu } from "./theme-menu";

const EMPTY_PROJECTS: BackofficeProjectOption[] = [];

type BackofficeTopBarProps = {
  me: BackofficeMeData | null;
  resolvedScope: BackofficeResolvedScope<Organization> | null;
  projectCollectionSource: AutomationCollectionSourceState | null;
  isLoading?: boolean;
  workflowDrawerOpen?: boolean;
  onWorkflowDrawerToggle?: () => void;
};

function LocalFirstBackofficeProjectMenu({
  routeScope,
  currentProjectId,
  sourceState,
}: {
  routeScope: Extract<BackofficeRouteScope, { kind: "org" | "project" }>;
  currentProjectId: string | null;
  sourceState: AutomationCollectionSourceState | null;
}) {
  const loadingMenu = (
    <BackofficeProjectMenu
      routeScope={routeScope}
      currentProjectId={currentProjectId}
      projects={EMPTY_PROJECTS}
      projectsError={null}
      projectsLoading
    />
  );
  if (!sourceState || sourceState.status === "unavailable") {
    return (
      <BackofficeProjectMenu
        routeScope={routeScope}
        currentProjectId={currentProjectId}
        projects={EMPTY_PROJECTS}
        projectsError={sourceState?.message ?? "Project synchronization is unavailable."}
        projectsLoading={false}
      />
    );
  }

  // Backoffice cannot operate without its local-first database, so initialization failures are
  // intentionally allowed to reach the route error boundary instead of rendering degraded UI.
  return (
    <ClientOnly fallback={loadingMenu}>
      <Suspense fallback={loadingMenu}>
        <SynchronizedBackofficeProjectMenu
          routeScope={routeScope}
          currentProjectId={currentProjectId}
          source={sourceState.source}
        />
      </Suspense>
    </ClientOnly>
  );
}

function SynchronizedBackofficeProjectMenu({
  routeScope,
  currentProjectId,
  source,
}: {
  routeScope: Extract<BackofficeRouteScope, { kind: "org" | "project" }>;
  currentProjectId: string | null;
  source: AutomationCollectionSource;
}) {
  const { collections } = use(getAutomationBrowserDatabase(source));
  const projectsState = useAutomationProjects(collections);
  const projects = projectsState.projects.map((project) => ({
    id: project.id,
    label: project.name.trim() || project.slug.trim() || project.id,
  }));

  return (
    <BackofficeProjectMenu
      routeScope={routeScope}
      currentProjectId={currentProjectId}
      projects={projects}
      projectsError={projectsState.status === "error" ? projectsState.message : null}
      projectsLoading={projectsState.status === "loading"}
    />
  );
}

export function BackofficeTopBar({
  me,
  resolvedScope,
  projectCollectionSource,
  isLoading,
  workflowDrawerOpen = false,
  onWorkflowDrawerToggle,
}: BackofficeTopBarProps) {
  const routeScope = resolvedScope ? backofficeRouteScopeFromResolvedScope(resolvedScope) : null;

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-bg)]">
      <div className="flex h-16 items-stretch">
        <div className="flex min-w-0 flex-1 items-stretch min-[960px]:w-72 min-[960px]:flex-none min-[960px]:border-r min-[960px]:border-[color:var(--bo-border)]">
          <BackofficeScopeMenu me={me} currentScope={resolvedScope} />
        </div>

        {resolvedScope?.kind === "org" || resolvedScope?.kind === "project" ? (
          <div className="flex min-w-0 flex-1 items-stretch min-[960px]:w-72 min-[960px]:flex-none min-[960px]:border-r min-[960px]:border-[color:var(--bo-border)]">
            <LocalFirstBackofficeProjectMenu
              routeScope={
                resolvedScope.kind === "org"
                  ? { kind: "org", orgSlug: resolvedScope.organization.slug }
                  : {
                      kind: "project",
                      orgSlug: resolvedScope.organization.slug,
                      projectId: resolvedScope.projectId,
                    }
              }
              currentProjectId={resolvedScope.kind === "project" ? resolvedScope.projectId : null}
              sourceState={projectCollectionSource}
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
          <BackofficeAccountMenu me={me} currentScope={routeScope} isLoading={isLoading} />
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] min-[960px]:hidden">
        <BackofficeMobileNav currentScope={routeScope} />
      </div>
    </header>
  );
}
