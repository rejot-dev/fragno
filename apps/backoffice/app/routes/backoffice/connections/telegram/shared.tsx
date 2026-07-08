import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import type { IntegrationScopeSwitchOption } from "../../integrations/scope";
import { IntegrationScopeBreadcrumbSelector } from "../../integrations/scope-selector";
import { getRouteErrorMessage, isOrganisationNotFoundError } from "../../route-errors";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

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
  organisation: BackofficeOrganisation | null;
  scope: BackofficeContextScope;
  scopeSegment: string;
  label: string;
  basePath: string;
  integrationsPath: string;
  configState: TelegramConfigState | null;
  configLoading: boolean;
  configError: string | null;
  scopeOptions: IntegrationScopeSwitchOption[];
  setConfigState: Dispatch<SetStateAction<TelegramConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type TelegramTab = "messages" | "configuration";

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

export const generateSecretToken = () => {
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi?.randomUUID) {
    return `tg_${cryptoApi.randomUUID().replace(/-/g, "")}`;
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `tg_${token}`;
  }
  throw new Error("Secure crypto API unavailable for generating a Telegram secret token.");
};

export function TelegramHeader({
  organisationName,
  integrationsPath,
  scopeOptions,
}: {
  organisationName?: string | null;
  integrationsPath: string;
  scopeOptions: IntegrationScopeSwitchOption[];
}) {
  const scopeLabel = organisationName ?? "Scope";

  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Automations", to: "/backoffice/automations" },
        {
          label: <IntegrationScopeBreadcrumbSelector label={scopeLabel} options={scopeOptions} />,
        },
        { label: "Integrations", to: integrationsPath },
        { label: "Telegram" },
      ]}
      eyebrow="Integrations"
      title={`Telegram for ${scopeLabel}`}
      description="Connect a Telegram bot, capture chat activity, and review messages per organisation."
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
    <div
      role="tablist"
      aria-label="Telegram backoffice tabs"
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

  if (statusCode === 404 && isOrganisationNotFoundError(error)) {
    message = "Organisation for this scope could not be found.";
  }

  return (
    <div className="space-y-4">
      <TelegramHeader
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
