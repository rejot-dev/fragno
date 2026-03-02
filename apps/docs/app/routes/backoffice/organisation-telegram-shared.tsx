import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeOrganisation } from "./organisations.data";

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
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  configState: TelegramConfigState | null;
  configLoading: boolean;
  configError: string | null;
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
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `tg_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `tg_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`;
};

export function TelegramHeader({
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
        { label: "Organisations", to: "/backoffice/organisations" },
        { label: organisationName ?? orgId, to: `/backoffice/organisations/${orgId}/telegram` },
        { label: "Telegram" },
      ]}
      eyebrow="Integrations"
      title={`Telegram for ${organisationName ?? orgId}`}
      description="Connect a Telegram bot, capture chat activity, and review messages per organisation."
      actions={
        <Link
          to="/backoffice/organisations"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to organisations
        </Link>
      }
    />
  );
}

export function TelegramTabs({
  orgId,
  activeTab,
  isConfigured,
}: {
  orgId: string;
  activeTab: TelegramTab;
  isConfigured: boolean;
}) {
  const basePath = `/backoffice/organisations/${orgId}/telegram`;
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
    message = typeof error.data === "string" ? error.data : message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  if (statusCode === 404 && params.orgId) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <TelegramHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
