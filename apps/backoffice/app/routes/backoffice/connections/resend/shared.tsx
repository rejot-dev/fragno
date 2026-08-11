import type { Dispatch, SetStateAction } from "react";
import { isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import { AutomationSubpageTabs } from "../../automations/shared";
import { getRouteErrorMessage, isOrganisationNotFoundError } from "../../route-errors";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type ResendConfigState = {
  configured: boolean;
  config?: {
    defaultFrom?: string | null;
    defaultReplyTo?: string[] | null;
    webhookBaseUrl?: string | null;
    webhookId?: string | null;
    apiKeyPreview?: string;
    webhookSecretPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  webhook?: {
    ok: boolean;
    message: string;
  };
};

export type ResendLayoutContext = {
  origin: string;
  organisation: BackofficeOrganisation | null;
  scope: BackofficeContextScope;
  scopeSegment: string;
  label: string;
  basePath: string;
  integrationsPath: string;
  configState: ResendConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<ResendConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type ResendTab = "threads" | "incoming" | "outgoing" | "domains" | "configuration";

export function ResendTabs({
  basePath,
  activeTab,
  isConfigured,
}: {
  basePath: string;
  activeTab: ResendTab;
  isConfigured: boolean;
}) {
  const tabs = [
    {
      id: "threads" as const,
      label: "Threads",
      to: `${basePath}/threads`,
      disabled: !isConfigured,
    },
    {
      id: "incoming" as const,
      label: "Incoming",
      to: `${basePath}/incoming`,
      disabled: !isConfigured,
    },
    {
      id: "outgoing" as const,
      label: "Outgoing",
      to: `${basePath}/outgoing`,
      disabled: !isConfigured,
    },
    {
      id: "domains" as const,
      label: "Domains",
      to: `${basePath}/domains`,
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
      ariaLabel="Resend integration sections"
    />
  );
}

export function ResendErrorBoundary({
  error,
}: {
  error: unknown;
  params: { scopeKind?: string; scopeId?: string };
}) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";
  const isDev = import.meta.env.MODE === "development";
  const stack = error instanceof Error ? error.stack : null;

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
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Automations", to: "/backoffice/automations" },
          { label: "Resend" },
        ]}
        eyebrow="Integrations"
        title="Resend integration unavailable"
        description="The Resend automation integration could not be loaded."
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
