import type { ReactNode } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../route-errors";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type AutomationScriptItem = {
  id: string;
  key: string;
  name: string;
  engine: string;
  script: string | null;
  path: string;
  absolutePath: string;
  version: number | null;
  scriptLoadError?: string | null;
  bindingIds: string[];
  bindingCount: number;
  enabledBindingCount: number;
  enabled: boolean;
};

export type AutomationTriggerItem = {
  id: string;
  source: string;
  eventType: string;
  scriptId: string;
  scriptKey: string;
  scriptName: string;
  scriptPath: string;
  absoluteScriptPath: string;
  scriptVersion: number;
  scriptEngine: string;
  scriptEnv: Record<string, string>;
  enabled: boolean;
  scriptLoadError?: string | null;
  triggerOrder?: number | null;
};

export type AutomationIdentityItem = {
  id: string;
  source: string;
  key: string;
  value: string;
  description?: string | null;
  status: string;
  linkedAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationScenarioStepItem = {
  index: number;
  id: string;
  title?: string;
  event: {
    id: string;
    orgId?: string;
    source: string;
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    actor?: {
      type?: string;
      externalId?: string;
      [key: string]: unknown;
    } | null;
    subject?: {
      orgId?: string;
      userId?: string;
      [key: string]: unknown;
    } | null;
  };
  matchedBindingIds: string[];
  matchedScriptIds: string[];
  matchedScriptKeys: string[];
  matchedScriptPaths: string[];
};

export type AutomationScenarioItem = {
  id: string;
  path: string;
  relativePath: string;
  fileName: string;
  name: string;
  description?: string;
  env: Record<string, string>;
  initialState?: unknown;
  commandMocks?: unknown;
  stepCount: number;
  relatedBindingIds: string[];
  relatedScriptIds: string[];
  relatedScriptKeys: string[];
  relatedScriptPaths: string[];
  sources: string[];
  eventTypes: string[];
  steps: AutomationScenarioStepItem[];
};

export type AutomationLayoutContext = {
  orgId: string;
  organisation: BackofficeOrganisation;
  scripts: AutomationScriptItem[];
  triggerBindings: AutomationTriggerItem[];
  identityBindings: AutomationIdentityItem[];
  scriptsError: string | null;
  triggerBindingsError: string | null;
  identityBindingsError: string | null;
};

export type AutomationTab = "scripts" | "identity";

export const formatTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "—";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export const formatAutomationSource = (value: string) => {
  if (!value) {
    return "Unknown";
  }

  if (value.toLowerCase() === "otp") {
    return "OTP";
  }

  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
};

export function AutomationHeader({
  orgId,
  organisationName,
}: {
  orgId: string;
  organisationName?: string | null;
}) {
  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Automations", to: "/backoffice/automations" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Automations"
      title={`Automations for ${organisationName ?? orgId}`}
      description="Inspect filesystem-backed automation bindings and shell scripts for this organisation. Edit the underlying files through Backoffice Files under /workspace/automations."
      actions={
        <Link
          to={`/backoffice/organisations/${orgId}`}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          View organisation
        </Link>
      }
    />
  );
}

export function AutomationTabs({ orgId, activeTab }: { orgId: string; activeTab: AutomationTab }) {
  const basePath = `/backoffice/automations/${orgId}`;
  const tabs = [
    {
      id: "scripts" as const,
      label: "Scripts",
      to: `${basePath}/scripts`,
    },
    {
      id: "identity" as const,
      label: "Identity",
      to: `${basePath}/identity`,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="Automation backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const className = isActive
          ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
          : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

        return (
          <Link key={tab.id} to={tab.to} role="tab" aria-selected={isActive} className={className}>
            {tab.label}
          </Link>
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
  params: { orgId?: string };
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
      <AutomationHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}

export function AutomationStatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-2xl font-semibold text-[var(--bo-fg)]">{value}</p>
        {detail ? (
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {detail}
          </span>
        ) : null}
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

const AUTOMATION_WORKSPACE_PREFIX = "/workspace/";

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

const toWorkspaceRelativePath = (value: string) =>
  value.startsWith(AUTOMATION_WORKSPACE_PREFIX)
    ? value.slice(AUTOMATION_WORKSPACE_PREFIX.length)
    : value.replace(/^\/+/, "");

const folderPathFromWorkspaceFile = (path: string) => {
  const relativePath = toWorkspaceRelativePath(path).replace(/\/+$/, "");

  if (!relativePath) {
    return "automations";
  }

  const separatorIndex = relativePath.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return "automations";
  }

  return relativePath.slice(0, separatorIndex);
};

export function AutomationWorkspaceLoadError({
  title,
  error,
  orgId,
}: {
  title: string;
  error: string;
  orgId: string;
}) {
  const details = parseAutomationLoadError(error);
  const normalizedTitle = title.trim() || "Script loading issue";

  if (details.kind === "missing-script") {
    const scriptFolderPath = folderPathFromWorkspaceFile(details.scriptPath);
    const scriptBrowserPath = `/backoffice/files/${orgId}?path=${encodeURIComponent(scriptFolderPath)}`;
    const workspaceRootPath = `/backoffice/files/${orgId}?path=automations`;

    return (
      <AutomationNotice tone="error">
        <p className="text-[10px] tracking-[0.22em] uppercase">{normalizedTitle}</p>
        <p className="mt-2 text-xs text-red-700/90 dark:text-red-200/90">
          A workspace binding references a missing script.
        </p>

        <dl className="mt-3 grid gap-2 text-xs md:grid-cols-2">
          <div>
            <dt className="text-[9px] tracking-[0.22em] text-red-700/80 uppercase dark:text-red-200/80">
              Binding
            </dt>
            <dd className="mt-1 font-mono text-[11px] break-all text-[var(--bo-fg)]">
              {details.bindingId}
            </dd>
          </div>
          <div>
            <dt className="text-[9px] tracking-[0.22em] text-red-700/80 uppercase dark:text-red-200/80">
              Missing script
            </dt>
            <dd className="mt-1 font-mono text-[11px] break-all text-[var(--bo-fg)]">
              {details.scriptPath}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-[var(--bo-fg)]">{details.cause}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to={scriptBrowserPath}
            className="border border-red-400/40 bg-red-500/8 px-3 py-1.5 text-[10px] font-semibold tracking-[0.22em] text-red-700 uppercase transition-colors hover:border-red-400/60 hover:bg-red-500/12 dark:text-red-200"
          >
            Open script folder
          </Link>
          <Link
            to={workspaceRootPath}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1.5 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)]"
          >
            Open automations workspace
          </Link>
        </div>
      </AutomationNotice>
    );
  }

  return (
    <AutomationNotice tone="error">
      <p className="text-[10px] tracking-[0.22em] uppercase">{normalizedTitle}</p>
      <p className="mt-2 text-xs">{details.message}</p>
    </AutomationNotice>
  );
}

export function AutomationBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "error";
}) {
  const className =
    tone === "accent"
      ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
      : tone === "success"
        ? "border-emerald-400/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-200"
        : tone === "error"
          ? "border-red-400/50 bg-red-500/12 text-red-700 dark:text-red-200"
          : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";

  return (
    <span className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${className}`}>
      {children}
    </span>
  );
}
