import type { Dispatch, SetStateAction } from "react";
import { isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeMeData } from "@/fragno/auth/auth-client";

import { AutomationSubpageTabs } from "../../automations/shared";
import { getRouteErrorMessage, getBackofficeOrganizationNotFound } from "../../route-errors";

type BackofficeOrganization = BackofficeMeData["organizations"][number]["organization"];

export type Reson8ConfigState = {
  configured: boolean;
  config?: {
    apiKeyPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};

export type Reson8LayoutContext = {
  organization: BackofficeOrganization;
  scope: BackofficeContextScope;
  scopeSegment: string;
  label: string;
  basePath: string;
  integrationsPath: string;
  configState: Reson8ConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<Reson8ConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type Reson8Tab = "transcribe" | "custom-models" | "configuration";

export function Reson8Tabs({
  basePath,
  activeTab,
  isConfigured,
}: {
  basePath: string;
  activeTab: Reson8Tab;
  isConfigured: boolean;
}) {
  const tabs = [
    {
      id: "transcribe" as const,
      label: "Transcribe",
      to: `${basePath}/transcribe`,
      disabled: !isConfigured,
    },
    {
      id: "custom-models" as const,
      label: "Custom models",
      to: `${basePath}/custom-models`,
      disabled: !isConfigured,
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
      ariaLabel="Reson8 integration sections"
    />
  );
}

export function Reson8ErrorBoundary({
  error,
}: {
  error: unknown;
  params: { scopeKind?: string; scopeId?: string };
}) {
  let statusCode = 500;
  let statusText = "Error";
  let message = "An unexpected error occurred.";
  const isDev = import.meta.env.MODE === "development";
  const stack = error instanceof Error ? error.stack : null;

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
          { label: "Reson8" },
        ]}
        eyebrow="Integrations"
        title="Reson8 integration unavailable"
        description="The Reson8 automation integration could not be loaded."
      />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
        {isDev && stack ? (
          <pre className="mt-3 text-xs break-words whitespace-pre-wrap text-[var(--bo-muted-2)]">
            {stack}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
