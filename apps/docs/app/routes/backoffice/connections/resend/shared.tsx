import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import type { ResendDomain } from "@fragno-dev/resend-fragment";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth-client";

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
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  configState: ResendConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<ResendConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type ResendTab = "threads" | "incoming" | "outgoing" | "domains" | "configuration";

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

export const getResendDomainStatusTone = (status: ResendDomain["status"]) => {
  switch (status) {
    case "verified":
      return "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]";
    case "failed":
    case "temporary_failure":
      return "border-red-500/40 bg-red-500/10 text-red-300";
    default:
      return "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
  }
};

export const formatResendDomainStatus = (status: ResendDomain["status"]) =>
  status.replace(/_/g, " ");

export const formatResendCapability = (value: ResendDomain["capabilities"]["sending"]) =>
  value === "enabled" ? "Enabled" : "Disabled";

export function ResendHeader({
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
        { label: "Connections", to: "/backoffice/connections" },
        { label: "Resend", to: "/backoffice/connections/resend" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Integrations"
      title={`Resend for ${organisationName ?? orgId}`}
      description="Connect Resend to send and receive email, inspect domains, manage threads, and monitor delivery state."
      actions={
        <Link
          to="/backoffice/connections/resend"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to Resend
        </Link>
      }
    />
  );
}

export function ResendTabs({
  orgId,
  activeTab,
  isConfigured,
}: {
  orgId: string;
  activeTab: ResendTab;
  isConfigured: boolean;
}) {
  const basePath = `/backoffice/connections/resend/${orgId}`;
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
    <nav
      aria-label="Resend backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const ariaCurrent = isActive ? "page" : undefined;
        const className = isActive
          ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
          : tab.disabled
            ? "cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-60"
            : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

        if (tab.disabled) {
          return (
            <span key={tab.id} aria-disabled="true" className={className}>
              {tab.label}
            </span>
          );
        }

        return (
          <Link key={tab.id} to={tab.to} aria-current={ariaCurrent} className={className}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function ResendErrorBoundary({
  error,
  params,
}: {
  error: unknown;
  params: { orgId?: string };
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

  if (statusCode === 404 && params.orgId && isOrganisationNotFoundError(error)) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <ResendHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
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
