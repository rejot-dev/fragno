import { Fragment, type ReactNode } from "react";
import { Link, isRouteErrorResponse, useSearchParams } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../route-errors";
import type { AutomationTab } from "./layout-context";
import {
  automationScopeTabPath,
  type AutomationScopeOption,
  type AutomationUiScope,
} from "./scope";
import {
  SCRIPT_VIEW_MODE_SEARCH_PARAM,
  WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM,
  pathWithScriptPresentation,
  scriptViewModeFromSearchParam,
  workflowGraphDetailModeFromSearchParam,
} from "./script-view/script-view-mode";

export function useScriptPresentation() {
  const [searchParams] = useSearchParams();
  return {
    viewMode: scriptViewModeFromSearchParam(searchParams.get(SCRIPT_VIEW_MODE_SEARCH_PARAM)),
    graphDetailMode: workflowGraphDetailModeFromSearchParam(
      searchParams.get(WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM),
    ),
  };
}

export function AutomationHeader({ selectedScope }: { selectedScope: AutomationUiScope }) {
  const scopeLabel = selectedScope.label;
  const orgId =
    selectedScope.kind === "org" || selectedScope.kind === "project" ? selectedScope.orgId : null;

  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Automations", to: "/backoffice/automations" },
        { label: scopeLabel },
      ]}
      eyebrow="Automations"
      title={`Automations for ${scopeLabel}`}
      description="See the live system map, then inspect the scoped terminal, scripts, routes, events, integrations, sandboxes, and store bindings."
      actions={
        orgId ? (
          <Link
            to={`/backoffice/organisations/${orgId}`}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            View organisation
          </Link>
        ) : null
      }
    />
  );
}

export function AutomationScopePicker({
  selectedScope,
  scopeOptions,
  projectsError,
  createProjectPath,
  isCreatingProject = false,
}: {
  selectedScope: AutomationUiScope;
  scopeOptions: AutomationScopeOption[];
  projectsError: string | null;
  createProjectPath?: string;
  isCreatingProject?: boolean;
}) {
  const scriptPresentation = useScriptPresentation();
  const selectedId =
    selectedScope.kind === "system"
      ? "system:system"
      : selectedScope.kind === "project"
        ? `project:${selectedScope.projectId}`
        : selectedScope.kind === "org"
          ? `org:${selectedScope.orgId}`
          : `user:${selectedScope.userId}`;

  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Scope</p>
          <p className="mt-1 text-sm text-[var(--bo-muted)]">
            Select which automation runtime to inspect.
          </p>
        </div>
        {projectsError ? (
          <p className="text-xs text-red-700 dark:text-red-200">{projectsError}</p>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {scopeOptions.map((option) => {
          const isActive = !isCreatingProject && option.id === selectedId;
          return (
            <Link
              key={option.id}
              to={pathWithScriptPresentation(option.to, scriptPresentation)}
              className={
                isActive
                  ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-left text-[var(--bo-accent-fg)]"
                  : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              }
            >
              <span className="block text-[10px] font-semibold tracking-[0.22em] uppercase">
                {option.kind}
              </span>
              <span className="mt-1 block text-sm font-medium text-[var(--bo-fg)]">
                {option.label}
              </span>
              <span className="mt-1 block text-xs text-[var(--bo-muted-2)]">
                {option.description}
              </span>
            </Link>
          );
        })}
        {createProjectPath ? (
          <Link
            to={createProjectPath}
            preventScrollReset
            aria-current={isCreatingProject ? "page" : undefined}
            className={
              isCreatingProject
                ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-left text-[var(--bo-accent-fg)]"
                : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            }
          >
            <span className="block text-[10px] font-semibold tracking-[0.22em] uppercase">
              Project
            </span>
            <span className="mt-1 block text-sm font-medium text-[var(--bo-fg)]">+ New</span>
            <span className="mt-1 block text-xs text-[var(--bo-muted-2)]">
              Create project scope
            </span>
          </Link>
        ) : null}
      </div>
    </section>
  );
}

export function AutomationTabs({
  selectedScope,
  activeTab,
  disabled = false,
}: {
  selectedScope: AutomationUiScope;
  activeTab: AutomationTab;
  disabled?: boolean;
}) {
  const scriptPresentation = useScriptPresentation();
  const tabs = [
    {
      id: "dashboard" as const,
      label: "Dashboard",
      to: automationScopeTabPath(selectedScope, "dashboard"),
    },
    {
      id: "terminal" as const,
      label: "Terminal",
      to: automationScopeTabPath(selectedScope, "terminal"),
    },
    {
      id: "scripts" as const,
      label: "Scripts",
      to: automationScopeTabPath(selectedScope, "scripts"),
    },
    {
      id: "router" as const,
      label: "Router",
      to: automationScopeTabPath(selectedScope, "router"),
    },
    {
      id: "store" as const,
      label: "Store",
      to: automationScopeTabPath(selectedScope, "store"),
    },
    {
      id: "events" as const,
      label: "Events",
      to: automationScopeTabPath(selectedScope, "events"),
    },
    {
      id: "events-catalog" as const,
      label: "Events Catalog",
      to: automationScopeTabPath(selectedScope, "events-catalog"),
    },
    {
      id: "api" as const,
      label: "API",
      to: automationScopeTabPath(selectedScope, "api"),
    },
    {
      id: "integrations" as const,
      label: "Integrations",
      to: automationScopeTabPath(selectedScope, "integrations"),
    },
    {
      id: "mcp" as const,
      label: "MCP",
      to: automationScopeTabPath(selectedScope, "mcp"),
    },
    {
      id: "sandboxes" as const,
      label: "Sandboxes",
      to: automationScopeTabPath(selectedScope, "sandboxes"),
    },
  ].map((tab) => ({
    ...tab,
    disabled:
      disabled || (selectedScope.kind === "system" && ["api", "mcp", "sandboxes"].includes(tab.id)),
  }));

  return (
    <div
      role="tablist"
      aria-label="Automation backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = !tab.disabled && activeTab === tab.id;
        const className = tab.disabled
          ? "cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-50"
          : isActive
            ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
            : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

        return (
          <Fragment key={tab.id}>
            {tab.id === "terminal" ||
            tab.id === "scripts" ||
            tab.id === "store" ||
            tab.id === "api" ||
            tab.id === "sandboxes" ? (
              <span className="h-6 w-px bg-[var(--bo-border)]" aria-hidden="true" />
            ) : null}
            {tab.disabled ? (
              <span role="tab" aria-selected="false" aria-disabled="true" className={className}>
                {tab.label}
              </span>
            ) : (
              <Link
                to={pathWithScriptPresentation(tab.to, scriptPresentation)}
                role="tab"
                aria-selected={isActive}
                className={className}
              >
                {tab.label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function AutomationErrorBoundary({
  error,
  params,
}: {
  error: unknown;
  params: { orgId?: string; scopeId?: string; scopeKind?: string };
}) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
  }

  message = getRouteErrorMessage(error, message);

  if (statusCode === 404 && params.orgId && isOrganisationNotFoundError(error)) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <AutomationHeader
        selectedScope={{
          kind: "org",
          orgId: params.orgId ?? params.scopeId ?? "organisation",
          label: "Error",
        }}
      />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}

export function AutomationNotice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error";
}) {
  return (
    <div
      className={
        tone === "error"
          ? "border border-red-400/40 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-200"
          : "border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-sm text-[var(--bo-muted)]"
      }
    >
      {children}
    </div>
  );
}
