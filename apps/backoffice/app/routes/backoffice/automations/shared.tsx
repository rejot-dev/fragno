import { Fragment, type ReactNode } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import type {
  AutomationEventRecord,
  AutomationRouteDefinition,
  AutomationScriptLayer,
} from "@/fragno/automation";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import type { SandboxInstanceSummary } from "@/sandbox/contracts";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../route-errors";
import {
  automationScopeTabPath,
  type AutomationScopeOption,
  type AutomationUiScope,
} from "./scope";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type AutomationScriptItem = {
  id: string;
  key: string;
  name: string;
  engine: string;
  layer: AutomationScriptLayer;
  readOnly: boolean;
  script: string | null;
  path: string;
  absolutePath: string;
  version: number | null;
  scriptLoadError?: string | null;
  enabled: boolean;
};

export type AutomationRouteItem = AutomationRouteDefinition;

export type AutomationEventItem = AutomationEventRecord;

export type AutomationStoreItem = {
  id: string;
  key: string;
  value: string;
  description?: string | null;
  category: string[];
  actor: AutomationEventActor | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationLocalStoreState = {
  entries: AutomationStoreItem[];
  synced: boolean;
  error: string | null;
};

export type AutomationLocalRoutesState = {
  routes: AutomationRouteItem[];
  synced: boolean;
  error: string | null;
};

export type AutomationLocalEventsState = {
  events: AutomationEventItem[];
  synced: boolean;
  error: string | null;
};

export type AutomationLocalSandboxesState = {
  sandboxes: SandboxInstanceSummary[];
  synced: boolean;
  error: string | null;
};

export type AutomationLocalScopeState = {
  store: AutomationLocalStoreState;
  routes: AutomationLocalRoutesState;
  events: AutomationLocalEventsState;
  sandboxes: AutomationLocalSandboxesState;
};

export type AutomationServerLofiDataState<TData> = {
  data: TData;
  source: "server" | "lofi";
  synced: boolean;
  serverError: string | null;
  syncError: string | null;
  blockingError: string | null;
};

export const resolveAutomationServerLofiData = <TData,>({
  serverData,
  serverError,
  lofiData,
  lofiSynced,
  lofiError,
  isEmpty,
}: {
  serverData: TData;
  serverError: string | null;
  lofiData: TData;
  lofiSynced: boolean;
  lofiError: string | null;
  isEmpty?: (data: TData) => boolean;
}): AutomationServerLofiDataState<TData> => {
  const data = lofiSynced ? lofiData : serverData;
  const normalizedServerError = serverError?.trim() || null;

  return {
    data,
    source: lofiSynced ? "lofi" : "server",
    synced: lofiSynced,
    serverError: normalizedServerError,
    syncError: lofiError?.trim() || null,
    blockingError: normalizedServerError && isEmpty?.(data) ? normalizedServerError : null,
  };
};

export type AutomationLayoutContext = {
  orgId: string;
  organisation: BackofficeOrganisation;
  selectedScope: AutomationUiScope;
  scopeOptions: AutomationScopeOption[];
  projectsError: string | null;
  scripts: AutomationScriptItem[];
  routes: AutomationRouteItem[];
  storeEntries: AutomationStoreItem[];
  events: AutomationEventItem[];
  eventsCursor?: string;
  eventsHasNextPage: boolean;
  eventsCurrentCursor: string | null;
  eventsPageSize: number;
  storeData: AutomationServerLofiDataState<AutomationStoreItem[]>;
  routesData: AutomationServerLofiDataState<AutomationRouteItem[]>;
  eventsData: AutomationServerLofiDataState<AutomationEventItem[]>;
  lofiStore: AutomationLocalStoreState;
  lofiRoutes: AutomationLocalRoutesState;
  lofiEvents: AutomationLocalEventsState;
  lofiSandboxes: AutomationLocalSandboxesState;
  storePrefix: string;
  scriptsError: string | null;
  routesError: string | null;
  storeEntriesError: string | null;
  eventsError: string | null;
};

export type AutomationTab =
  | "terminal"
  | "scripts"
  | "router"
  | "store"
  | "api"
  | "events"
  | "events-catalog"
  | "integrations"
  | "mcp"
  | "sandboxes";

export const formatTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "—";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const month = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(date);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  return `${month} ${day}, ${year}, ${hours}:${minutes} UTC`;
};

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
      description="Inspect the scoped terminal, automation scripts, API connections, events, MCP servers, sandboxes, and store bindings for the selected scope."
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
              to={option.to}
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
  const tabs = [
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
            {tab.id === "scripts" ||
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
              <Link to={tab.to} role="tab" aria-selected={isActive} className={className}>
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

const MISSING_SCRIPT_ERROR_RE =
  /^Automation script for binding '([^']+)' '([^']+)' was not found in the automation workspace:\s*(.+)$/;

export type AutomationLoadErrorDetails =
  | {
      kind: "missing-script";
      bindingId: string;
      scriptPath: string;
      cause: string;
    }
  | {
      kind: "generic";
      message: string;
    };

export const parseAutomationLoadError = (error: string): AutomationLoadErrorDetails => {
  const match = error.match(MISSING_SCRIPT_ERROR_RE);
  if (match) {
    return {
      kind: "missing-script",
      bindingId: match[1],
      scriptPath: match[2],
      cause: match[3]?.trim() || "File not found.",
    };
  }

  return {
    kind: "generic",
    message: error,
  };
};
