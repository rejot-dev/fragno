import type { Dispatch, SetStateAction } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import type { PiConfigState } from "@/fragno/pi/pi-shared";
import type { PiCollectionSource } from "@/fragno/pi/tanstack/browser-database";

import {
  getRouteErrorDebugDetails,
  getRouteErrorMessage,
  isOrganisationNotFoundError,
} from "../route-errors";

export type PiLayoutContext = {
  scope: Extract<BackofficeContextScope, { kind: "org" }>;
  persistenceSource: PiCollectionSource | null;
  persistenceError: string | null;
  configState: PiConfigState | null;
  configError: string | null;
  setConfigState: Dispatch<SetStateAction<PiConfigState | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type PiTab = "sessions" | "harnesses" | "configuration";

export function PiHeader({
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
        { label: "Sessions", to: "/backoffice/sessions" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Agents"
      title={`Pi sessions for ${organisationName ?? orgId}`}
      description="Create, inspect, and manage Pi agent sessions for your organisation."
    />
  );
}

export function PiTabs({
  orgId,
  activeTab,
  isConfigured,
}: {
  orgId: string;
  activeTab: PiTab;
  isConfigured: boolean;
}) {
  const basePath = `/backoffice/sessions/${orgId}`;
  const tabs = [
    {
      id: "sessions" as const,
      label: "Sessions",
      to: `${basePath}/sessions`,
      disabled: !isConfigured,
    },
    {
      id: "harnesses" as const,
      label: "Harnesses",
      to: `${basePath}/harnesses`,
      disabled: false,
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
      aria-label="Pi backoffice tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const className = isActive
          ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
          : tab.disabled
            ? "inline-flex items-center gap-2 cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-60"
            : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

        if (tab.disabled) {
          return (
            <span
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-disabled="true"
              className={className}
              title="Configure API keys and add at least one harness to enable sessions."
            >
              {tab.label}
              <span className="rounded border border-[color:var(--bo-border-strong)] px-1.5 py-0.5 text-[8px] tracking-[0.18em] text-[var(--bo-muted)]">
                Setup required
              </span>
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

export function PiErrorBoundary({ error, params }: { error: unknown; params: { orgId?: string } }) {
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

  const debugDetails =
    import.meta.env.MODE === "development" ? getRouteErrorDebugDetails(error) : null;

  return (
    <div className="space-y-4">
      <PiHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
        {debugDetails ? (
          <details className="mt-4" open>
            <summary className="cursor-pointer text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Error details
            </summary>
            <pre className="mt-3 max-h-[60vh] overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs whitespace-pre-wrap text-[var(--bo-fg)]">
              {debugDetails}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
