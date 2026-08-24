import type { Dispatch, SetStateAction } from "react";
import { isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeMeData } from "@/fragno/auth/auth-client";

import { AutomationSubpageTabs } from "../../automations/shared";
import { getRouteErrorMessage, getBackofficeOrganizationNotFound } from "../../route-errors";

type BackofficeOrganization = BackofficeMeData["organizations"][number]["organization"];

export type TelegramConfigState = {
  configured: boolean;
  config?: {
    botUsername?: string | null;
    apiBaseUrl?: string | null;
    webhookBaseUrl?: string | null;
    botTokenPreview?: string;
    webhookSecretTokenPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  webhook?: {
    ok: boolean;
    message: string;
  };
};

export type TelegramLayoutContext = {
  origin: string;
  organization: BackofficeOrganization | null;
  scope: BackofficeContextScope;
  scopeSegment: string;
  label: string;
  basePath: string;
  integrationsPath: string;
  configState: TelegramConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<TelegramConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type TelegramTab = "messages" | "configuration";

export function TelegramTabs({
  basePath,
  activeTab,
  isConfigured,
}: {
  basePath: string;
  activeTab: TelegramTab;
  isConfigured: boolean;
}) {
  const tabs = [
    {
      id: "messages" as const,
      label: "Messages",
      to: `${basePath}/messages`,
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
      ariaLabel="Telegram integration sections"
    />
  );
}

export function TelegramErrorBoundary({
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
          { label: "Telegram" },
        ]}
        eyebrow="Integrations"
        title="Telegram integration unavailable"
        description="The Telegram automation integration could not be loaded."
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
