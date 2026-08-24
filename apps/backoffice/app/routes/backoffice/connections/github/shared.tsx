import type { Dispatch, SetStateAction } from "react";
import { isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeMeData } from "@/fragno/auth/auth-client";

import { AutomationSubpageTabs } from "../../automations/shared";
import { getRouteErrorMessage, getBackofficeOrganizationNotFound } from "../../route-errors";

type BackofficeOrganization = BackofficeMeData["organizations"][number]["organization"];

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
  organization: BackofficeOrganization | null;
  basePath: string;
  integrationsPath: string;
  configState: GitHubAdminConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<GitHubAdminConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type GitHubTab = "repositories" | "configuration";

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
    <AutomationSubpageTabs
      tabs={tabs}
      activeTab={activeTab}
      ariaLabel="GitHub integration sections"
    />
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

  if (statusCode === 404 && getBackofficeOrganizationNotFound(error)) {
    message = "Organization for this scope could not be found.";
  }

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Automations", to: "/backoffice/automations" },
          { label: "GitHub" },
        ]}
        eyebrow="Integrations"
        title="GitHub integration unavailable"
        description="The GitHub automation integration could not be loaded."
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
