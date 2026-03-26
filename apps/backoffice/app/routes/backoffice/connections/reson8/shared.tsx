import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../../route-errors";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type Reson8ConfigState = {
  configured: boolean;
  config?: {
    apiKeyPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};

export type Reson8LayoutContext = {
  orgId: string;
  organisation: BackofficeOrganisation;
  configState: Reson8ConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<Reson8ConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type Reson8Tab = "transcribe" | "custom-models" | "configuration";

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

export function Reson8Header({
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
        { label: "Reson8", to: "/backoffice/connections/reson8" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Integrations"
      title={`Reson8 for ${organisationName ?? orgId}`}
      description="Connect Reson8 to transcribe prerecorded audio, run realtime speech capture, and manage custom vocabulary models."
    />
  );
}

export function Reson8Tabs({
  orgId,
  activeTab,
  isConfigured,
}: {
  orgId: string;
  activeTab: Reson8Tab;
  isConfigured: boolean;
}) {
  const basePath = `/backoffice/connections/reson8/${orgId}`;
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
    <nav
      aria-label="Reson8 backoffice tabs"
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
            <span key={tab.id} aria-disabled="true" className={className}>
              {tab.label}
            </span>
          );
        }

        return (
          <Link
            key={tab.id}
            to={tab.to}
            aria-current={isActive ? "page" : undefined}
            className={className}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Reson8ErrorBoundary({
  error,
  params,
}: {
  error: unknown;
  params: { orgId?: string };
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

  if (statusCode === 404 && params.orgId && isOrganisationNotFoundError(error)) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <Reson8Header orgId={params.orgId ?? "organisation"} organisationName="Error" />
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
