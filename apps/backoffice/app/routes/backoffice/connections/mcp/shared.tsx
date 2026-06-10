import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "../../route-errors";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type McpConfigState = {
  configured: boolean;
  config?: {
    publicBaseUrl?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
};

export type McpLayoutContext = {
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  configState: McpConfigState | null;
  configLoading: boolean;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<McpConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type McpTab = "configuration";

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

export function McpHeader({
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
        { label: "MCP", to: "/backoffice/connections/mcp" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Integrations"
      title={`MCP for ${organisationName ?? orgId}`}
      description="Register remote MCP servers, authenticate with OAuth or bearer tokens, and inspect tools per organisation."
      actions={
        <Link
          to="/backoffice/connections/mcp"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to MCP
        </Link>
      }
    />
  );
}

export function McpTabs({ orgId }: { orgId: string; activeTab: McpTab; isConfigured: boolean }) {
  return (
    <div
      role="tablist"
      aria-label="MCP backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      <Link
        to={`/backoffice/connections/mcp/${orgId}/configuration`}
        role="tab"
        aria-selected="true"
        className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
      >
        Configuration
      </Link>
    </div>
  );
}

export function McpErrorBoundary({
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
  }

  message = getRouteErrorMessage(error, message);

  if (statusCode === 404 && params.orgId && isOrganisationNotFoundError(error)) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <McpHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
