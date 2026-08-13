import type { ReactNode } from "react";
import { isRouteErrorResponse, useSearchParams } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../route-errors";
import type { AutomationTab } from "./layout-context";
import { automationScopeTabPath, resolveAutomationScopeTab, type AutomationUiScope } from "./scope";
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
] as const satisfies readonly (readonly {
  id: AutomationTab;
  label: string;
}[])[];

const AUTOMATION_TABS = AUTOMATION_TAB_GROUPS.flatMap((group, groupIndex) =>
  group.map((tab) => ({ ...tab, groupIndex })),
);

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
    <div className="flex flex-col bg-[color:var(--bo-sidebar-bg)] px-2 pt-4">
      <OverflowTabRow items={items} ariaLabel="Automation workspace sections" variant="browser" />
    </div>
  );
}

export type AutomationSubpageTab = {
  id: string;
  label: string;
  to: string;
  disabled?: boolean;
  onSelect?: () => void;
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

export function AutomationWorkspaceHeader({
  selectedScope,
  isCreatingProject = false,
  activeTab,
  subnav,
}: {
  selectedScope: AutomationUiScope;
  isCreatingProject?: boolean;
  activeTab: AutomationTab;
  subnav?: ReactNode;
}) {
  const scriptPresentation = useScriptPresentation();
  const workspaceLabel = isCreatingProject ? "New project" : selectedScope.label;

  return (
    <section className="bo-fragment-surface overflow-hidden bg-[var(--bo-header-bg)]">
      <h1 className="sr-only">Automations for {workspaceLabel}</h1>
      <AutomationTabRail
        selectedScope={selectedScope}
        activeTab={activeTab}
        disabled={isCreatingProject}
        scriptPresentation={scriptPresentation}
      />
      {subnav ? <div className="bg-[var(--bo-panel)] px-3 py-2 md:px-4">{subnav}</div> : null}
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
