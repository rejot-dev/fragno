import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth-client";
import type { UploadAdminConfigResponse } from "@/fragno/upload";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type UploadConfigState = UploadAdminConfigResponse;

export type UploadLayoutContext = {
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  configState: UploadConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<UploadConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type UploadProviderTab = "r2-binding" | "r2" | "s3" | "direct";
export type UploadTab = "files" | "configuration";
export type UploadConfigurableProvider = "r2-binding" | "r2";

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

export function UploadHeader({
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
        { label: "Upload", to: "/backoffice/connections/upload" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Integrations"
      title={`Upload for ${organisationName ?? orgId}`}
      description="Configure organisation-scoped upload storage with an enforced org namespace."
      actions={
        <Link
          to="/backoffice/connections/upload"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to Upload
        </Link>
      }
    />
  );
}

export function UploadWorkspaceTabs({
  orgId,
  activeTab,
  isConfigured,
}: {
  orgId: string;
  activeTab: UploadTab;
  isConfigured: boolean;
}) {
  const basePath = `/backoffice/connections/upload/${orgId}`;
  const tabs = [
    {
      id: "files" as const,
      label: "Files",
      to: `${basePath}/files`,
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
      aria-label="Upload workspace tabs"
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
            className={className}
            aria-current={isActive ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function UploadProviderTabs({
  activeProvider,
  onSelect,
}: {
  activeProvider: UploadProviderTab;
  onSelect?: (provider: UploadConfigurableProvider) => void;
}) {
  const tabs = [
    {
      id: "r2-binding" as const,
      label: "R2 Binding",
      description: null,
      disabled: false,
    },
    {
      id: "r2" as const,
      label: "R2 Keys",
      description: null,
      disabled: false,
    },
    {
      id: "s3" as const,
      label: "S3",
      description: "Coming soon",
      disabled: true,
    },
    {
      id: "direct" as const,
      label: "Direct",
      description: "Coming soon",
      disabled: true,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="Upload provider tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeProvider === tab.id;
        const className = isActive
          ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
          : tab.disabled
            ? "cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-60"
            : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)]";

        if (!tab.disabled && onSelect) {
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={className}
              onClick={() => onSelect(tab.id as UploadConfigurableProvider)}
            >
              {tab.label}
              {tab.description ? (
                <span className="ml-1 text-[9px] opacity-70">{tab.description}</span>
              ) : null}
            </button>
          );
        }

        return (
          <span
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-disabled={tab.disabled}
            className={className}
          >
            {tab.label}
            {tab.description ? (
              <span className="ml-1 text-[9px] opacity-70">{tab.description}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function UploadErrorBoundary({
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
      <UploadHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
