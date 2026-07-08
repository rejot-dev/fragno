import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import type { IntegrationScopeSwitchOption } from "../../integrations/scope";
import { IntegrationScopeBreadcrumbSelector } from "../../integrations/scope-selector";
import { getRouteErrorMessage, isOrganisationNotFoundError } from "../../route-errors";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type GitHubAdminConfigState = {
  configured: boolean;
  missing: string[];
  error: string | null;
  app?: {
    appId: string;
    appSlug: string;
    privateKeySource: "env" | "file";
    webhookSecretPreview: string;
    webhookUrl: string;
    installUrl: string;
    docsUrl: string;
  };
};

export type GitHubLayoutContext = {
  origin: string;
  organisation: BackofficeOrganisation | null;
  basePath: string;
  integrationsPath: string;
  configState: GitHubAdminConfigState | null;
  configLoading: boolean;
  configError: string | null;
  scopeOptions: IntegrationScopeSwitchOption[];
  setConfigState: Dispatch<SetStateAction<GitHubAdminConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type GitHubTab = "repositories" | "configuration";

export const formatTimestamp = (value?: string | Date | null) => {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export function GitHubHeader({
  organisationName,
  integrationsPath,
  scopeOptions,
}: {
  organisationName?: string | null;
  integrationsPath: string;
  scopeOptions: IntegrationScopeSwitchOption[];
}) {
  const scopeLabel = organisationName ?? "Organisation";

  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Automations", to: "/backoffice/automations" },
        {
          label: <IntegrationScopeBreadcrumbSelector label={scopeLabel} options={scopeOptions} />,
        },
        { label: "Integrations", to: integrationsPath },
        { label: "GitHub" },
      ]}
      eyebrow="Integrations"
      title={`GitHub for ${scopeLabel}`}
      description="Connect your GitHub App installation, link repositories, and inspect pull requests."
      actions={
        <Link
          to={integrationsPath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to integrations
        </Link>
      }
    />
  );
}

export function GitHubTabs({
  basePath,
  activeTab,
  repositoriesEnabled,
}: {
  basePath: string;
  activeTab: GitHubTab;
  repositoriesEnabled: boolean;
}) {
  const tabs = [
    {
      id: "repositories" as const,
      label: "Repositories",
      to: `${basePath}/repositories`,
      disabled: !repositoriesEnabled,
    },
    {
      id: "configuration" as const,
      label: "Configuration",
      to: `${basePath}/configuration`,
      disabled: false,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="GitHub backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const className = isActive
          ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
          : tab.disabled
            ? "cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-60"
            : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

        if (tab.disabled) {
          return (
            <span
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-disabled="true"
              className={className}
            >
              {tab.label}
            </span>
          );
        }

        return (
          <Link key={tab.id} to={tab.to} role="tab" aria-selected={isActive} className={className}>
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export function GitHubErrorBoundary({
  error,
}: {
  error: unknown;
  params: { scopeKind?: string; scopeId?: string };
}) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
  }

  message = getRouteErrorMessage(error, message);

  if (statusCode === 404 && isOrganisationNotFoundError(error)) {
    message = "Organisation for this scope could not be found.";
  }

  return (
    <div className="space-y-4">
      <GitHubHeader
        integrationsPath="/backoffice/automations"
        organisationName="Error"
        scopeOptions={[]}
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
