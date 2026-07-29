import { Menu } from "@base-ui/react/menu";
import { Fragment, type ReactNode } from "react";
import { Link, isRouteErrorResponse, useSearchParams } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { BackofficeBreadcrumbs, type BreadcrumbItem } from "@/components/backoffice/breadcrumbs";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../route-errors";
import type { AutomationTab } from "./layout-context";
import {
  automationScopeTabPath,
  automationUiScopeId,
  resolveAutomationScopeTab,
  type AutomationScopeOption,
  type AutomationUiScope,
} from "./scope";
import { usePreviousAutomationScope } from "./scope-history";
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

const AUTOMATION_SCOPE_GROUPS = [
  { kind: "system", label: "System" },
  { kind: "org", label: "Organisations" },
  { kind: "user", label: "Personal" },
  { kind: "project", label: "Projects" },
] as const;

const AUTOMATION_TAB_GROUPS = [
  [{ id: "dashboard", label: "Dashboard" }],
  [
    { id: "terminal", label: "Terminal" },
    { id: "scripts", label: "Scripts" },
    { id: "router", label: "Router" },
  ],
  [
    { id: "store", label: "Store" },
    { id: "events", label: "Events" },
    { id: "events-catalog", label: "Events Catalog" },
  ],
  [
    { id: "api", label: "API" },
    { id: "integrations", label: "Integrations" },
    { id: "mcp", label: "MCP" },
  ],
  [{ id: "sandboxes", label: "Sandboxes" }],
] as const satisfies readonly (readonly { id: AutomationTab; label: string }[])[];

const AUTOMATION_TABS = AUTOMATION_TAB_GROUPS.flatMap((group, groupIndex) =>
  group.map((tab) => ({ ...tab, groupIndex })),
);

const automationTabLabel = (activeTab: AutomationTab) => {
  for (const group of AUTOMATION_TAB_GROUPS) {
    const tab = group.find((candidate) => candidate.id === activeTab);
    if (tab) {
      return tab.label;
    }
  }

  throw new Error("Unsupported automation tab.");
};

const automationScopeKindLabel = (kind: AutomationUiScope["kind"]) => {
  switch (kind) {
    case "system":
      return "System";
    case "org":
      return "Org";
    case "project":
      return "Project";
    case "user":
      return "User";
  }

  throw new Error("Unsupported automation scope kind.");
};

const automationScopeItemContent = (option: AutomationScopeOption) => (
  <>
    <span className="flex min-w-0 items-center justify-between gap-4">
      <span className="truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
        {option.label}
      </span>
      <span className="shrink-0 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
        {automationScopeKindLabel(option.kind)}
      </span>
    </span>
    <span className="truncate text-xs tracking-normal text-[var(--bo-muted-2)] normal-case">
      {option.description}
    </span>
  </>
);

function AutomationScopeMenu({
  selectedScope,
  scopeOptions,
  projectsError,
  createProjectPath,
  isCreatingProject,
  scriptPresentation,
  activeTab,
  previousScopePathFor,
  triggerKindLabel,
  triggerLabel,
}: {
  selectedScope: AutomationUiScope;
  scopeOptions: AutomationScopeOption[];
  projectsError: string | null;
  createProjectPath?: string;
  isCreatingProject: boolean;
  scriptPresentation: ReturnType<typeof useScriptPresentation>;
  activeTab: AutomationTab;
  previousScopePathFor?: (scope: AutomationUiScope) => string | null;
  triggerKindLabel: string;
  triggerLabel: string;
}) {
  const selectedId = automationUiScopeId(selectedScope);
  const previousScope = usePreviousAutomationScope(selectedScope);
  const previousScopePath = previousScope
    ? previousScopePathFor
      ? previousScopePathFor(previousScope)
      : automationScopeTabPath(previousScope, resolveAutomationScopeTab(previousScope, activeTab))
    : null;

  return (
    <div className="flex w-full min-w-0 items-stretch gap-2 sm:w-auto">
      {previousScope && previousScopePath ? (
        <Link
          to={pathWithScriptPresentation(previousScopePath, scriptPresentation)}
          preventScrollReset
          title={`Return to ${previousScope.label}`}
          aria-label={`Return to the previous automation scope: ${previousScope.label}`}
          className="flex min-h-10 shrink-0 items-center gap-1.5 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] px-2.5 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-accent)] hover:bg-[var(--bo-accent-bg)] hover:text-[var(--bo-accent-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
        >
          <span className="text-[var(--bo-accent-fg)]" aria-hidden="true">
            ↶
          </span>
          Last
        </Link>
      ) : (
        <span
          aria-disabled="true"
          title="No previous automation scope in this tab"
          className="flex min-h-10 shrink-0 cursor-not-allowed items-center gap-1.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2.5 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase opacity-30"
        >
          <span aria-hidden="true">↶</span>
          Last
        </span>
      )}

      <Menu.Root modal={false}>
        <Menu.Trigger
          type="button"
          aria-label={`Switch automation scope. Current context: ${triggerLabel}`}
          className="group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] py-2 pr-2.5 pl-3 text-left transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:border-[color:var(--bo-accent)] data-[popup-open]:bg-[var(--bo-accent-bg)] sm:flex-none"
        >
          <span className="hidden shrink-0 text-[8px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase group-data-[popup-open]:text-[var(--bo-accent-fg)] lg:inline">
            Automation scope
          </span>
          <span
            className="hidden h-4 w-px shrink-0 bg-[var(--bo-border-strong)] lg:block"
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
              {triggerKindLabel}
            </span>
            <span className="text-[var(--bo-muted-2)]" aria-hidden="true">
              ·
            </span>
            <span className="min-w-0 truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
              {triggerLabel}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="shrink-0 text-xs text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180 group-data-[popup-open]:text-[var(--bo-accent-fg)]"
          >
            ▾
          </span>
        </Menu.Trigger>

        <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
          <Menu.Positioner side="bottom" align="end" sideOffset={10} style={{ zIndex: 2147483647 }}>
            <Menu.Popup
              data-backoffice-root
              className="relative max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] origin-top-left overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left tracking-normal text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
            >
              <p className="px-2 py-1 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Switch automation scope
              </p>

              {AUTOMATION_SCOPE_GROUPS.map((group) => {
                const options = scopeOptions.filter((option) => option.kind === group.kind);
                const isProjectGroup = group.kind === "project";
                const showProjectsError = isProjectGroup && projectsError;
                const showCreateProject = isProjectGroup && createProjectPath;
                if (options.length === 0 && !showProjectsError && !showCreateProject) {
                  return null;
                }

                return (
                  <Fragment key={group.kind}>
                    <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
                    <Menu.Group className="space-y-1">
                      <Menu.GroupLabel className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                        {group.label}
                      </Menu.GroupLabel>
                      {options.map((option) => {
                        const isCurrent = !isCreatingProject && option.id === selectedId;
                        const className = isCurrent
                          ? "grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left text-[var(--bo-accent-fg)] outline-none"
                          : "grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left text-[var(--bo-muted)] outline-none transition-[background-color,border-color,color] duration-150 ease-out data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";

                        return isCurrent ? (
                          <Menu.Item key={option.id} disabled className={className}>
                            {automationScopeItemContent(option)}
                          </Menu.Item>
                        ) : (
                          <Menu.Item
                            key={option.id}
                            render={
                              <Link
                                to={pathWithScriptPresentation(option.to, scriptPresentation)}
                                preventScrollReset
                              />
                            }
                            className={className}
                          >
                            {automationScopeItemContent(option)}
                          </Menu.Item>
                        );
                      })}
                      {showProjectsError ? (
                        <p className="px-2 py-1.5 text-xs text-red-700 dark:text-red-200">
                          {projectsError}
                        </p>
                      ) : null}
                      {showCreateProject ? (
                        isCreatingProject ? (
                          <Menu.Item
                            disabled
                            className="grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left outline-none"
                          >
                            <span className="text-sm font-medium text-[var(--bo-fg)]">
                              New project
                            </span>
                            <span className="text-xs text-[var(--bo-muted-2)]">
                              Creating a project-scoped runtime
                            </span>
                          </Menu.Item>
                        ) : (
                          <Menu.Item
                            render={<Link to={createProjectPath} preventScrollReset />}
                            className="grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left transition-[background-color,border-color,color] duration-150 ease-out outline-none data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]"
                          >
                            <span className="text-sm font-medium text-[var(--bo-fg)]">
                              + New project
                            </span>
                            <span className="text-xs text-[var(--bo-muted-2)]">
                              Create a project-scoped runtime
                            </span>
                          </Menu.Item>
                        )
                      ) : null}
                    </Menu.Group>
                  </Fragment>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function AutomationTabRail({
  selectedScope,
  activeTab,
  disabled,
  scriptPresentation,
}: {
  selectedScope: AutomationUiScope;
  activeTab: AutomationTab;
  disabled: boolean;
  scriptPresentation: ReturnType<typeof useScriptPresentation>;
}) {
  const items = AUTOMATION_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    groupId: String(tab.groupIndex),
    to: pathWithScriptPresentation(
      automationScopeTabPath(selectedScope, tab.id),
      scriptPresentation,
    ),
    disabled: disabled || resolveAutomationScopeTab(selectedScope, tab.id) !== tab.id,
    active: activeTab === tab.id,
  }));

  return (
    <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
      <OverflowTabRow items={items} ariaLabel="Automation workspace sections" />
    </div>
  );
}

export type AutomationSubpageTab = {
  id: string;
  label: string;
  to: string;
  disabled?: boolean;
};

export function AutomationSubpageTabs({
  tabs,
  activeTab,
  ariaLabel,
}: {
  tabs: readonly AutomationSubpageTab[];
  activeTab: string;
  ariaLabel: string;
}) {
  const items = tabs.map((tab) => ({
    ...tab,
    active: activeTab === tab.id,
  }));

  return <OverflowTabRow items={items} ariaLabel={ariaLabel} variant="underline" />;
}

type AutomationWorkspaceSubpage = {
  title: string;
  description?: string;
  navigation?: ReactNode;
  pathForScope?: (scope: AutomationUiScope) => string | null;
};

function AutomationSubpageHeader({ title, description, navigation }: AutomationWorkspaceSubpage) {
  return (
    <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 pt-3 md:px-4">
      <div className="min-w-0 space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          {title}
        </h2>
        {description ? (
          <p className="max-w-2xl text-sm text-pretty text-[var(--bo-muted)]">{description}</p>
        ) : null}
      </div>
      {navigation ? <div className="mt-3">{navigation}</div> : <div className="h-3" />}
    </div>
  );
}

export function AutomationWorkspaceHeader({
  selectedScope,
  scopeOptions,
  projectsError,
  createProjectPath,
  isCreatingProject = false,
  activeTab,
  breadcrumbTail,
  subpage,
}: {
  selectedScope: AutomationUiScope;
  scopeOptions: AutomationScopeOption[];
  projectsError: string | null;
  createProjectPath?: string;
  isCreatingProject?: boolean;
  activeTab: AutomationTab;
  breadcrumbTail?: BreadcrumbItem[];
  subpage?: AutomationWorkspaceSubpage;
}) {
  const scriptPresentation = useScriptPresentation();
  const workspaceKindLabel = isCreatingProject
    ? "Project"
    : automationScopeKindLabel(selectedScope.kind);
  const workspaceLabel = isCreatingProject ? "New project" : selectedScope.label;
  const activeTabBreadcrumbs: BreadcrumbItem[] =
    activeTab === "dashboard"
      ? []
      : [
          {
            label: automationTabLabel(activeTab),
            to: breadcrumbTail?.length
              ? pathWithScriptPresentation(
                  automationScopeTabPath(selectedScope, activeTab),
                  scriptPresentation,
                )
              : undefined,
          },
        ];
  const hasBreadcrumbTail = activeTabBreadcrumbs.length > 0 || Boolean(breadcrumbTail?.length);
  const breadcrumbs: BreadcrumbItem[] = [
    { label: "Backoffice", to: "/backoffice" },
    {
      label: "Automations",
      to: hasBreadcrumbTail ? "/backoffice/automations" : undefined,
    },
    ...activeTabBreadcrumbs,
    ...(breadcrumbTail ?? []),
  ];

  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Automations for {workspaceLabel}</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bo-product-code">AUT</span>
            <BackofficeBreadcrumbs items={breadcrumbs} />
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:max-w-md">
            <AutomationScopeMenu
              selectedScope={selectedScope}
              scopeOptions={scopeOptions}
              projectsError={projectsError}
              createProjectPath={createProjectPath}
              isCreatingProject={isCreatingProject}
              scriptPresentation={scriptPresentation}
              activeTab={activeTab}
              previousScopePathFor={subpage?.pathForScope}
              triggerKindLabel={workspaceKindLabel}
              triggerLabel={workspaceLabel}
            />
          </div>
        </div>
      </div>

      <AutomationTabRail
        selectedScope={selectedScope}
        activeTab={activeTab}
        disabled={isCreatingProject}
        scriptPresentation={scriptPresentation}
      />
      {subpage ? <AutomationSubpageHeader {...subpage} /> : null}
    </section>
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
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Automations", to: "/backoffice/automations" },
          { label: "Error" },
        ]}
        eyebrow="Automations"
        title="Automation workspace unavailable"
        description="The requested automation scope could not be opened."
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
