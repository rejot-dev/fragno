import type { Dispatch, SetStateAction } from "react";
import { isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import { BackofficeBreadcrumbs } from "@/components/backoffice/breadcrumbs";
import {
  BackofficeOrganisationScopeMenu,
  type BackofficeOrganisationScopeOption,
} from "@/components/backoffice/organisation-scope-menu";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";
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

const PI_TABS = [
  { id: "sessions", label: "Sessions" },
  { id: "harnesses", label: "Harnesses" },
  { id: "configuration", label: "Configuration" },
] as const satisfies readonly { id: PiTab; label: string }[];

const piTabLabel = (activeTab: PiTab) => {
  const tab = PI_TABS.find((candidate) => candidate.id === activeTab);
  if (!tab) {
    throw new Error("Unsupported Pi tab.");
  }
  return tab.label;
};

export function PiWorkspaceHeader({
  orgId,
  organisationName,
  organisationOptions,
  activeTab,
  isConfigured,
}: {
  orgId: string;
  organisationName?: string | null;
  organisationOptions: BackofficeOrganisationScopeOption[];
  activeTab: PiTab;
  isConfigured: boolean;
}) {
  const workspaceLabel = organisationName ?? orgId;
  const breadcrumbs = [
    { label: "Backoffice", to: "/backoffice" },
    {
      label: "Sessions",
      to: activeTab === "sessions" ? undefined : "/backoffice/sessions",
    },
    ...(activeTab === "sessions" ? [] : [{ label: piTabLabel(activeTab) }]),
  ];
  const basePath = `/backoffice/sessions/${encodeURIComponent(orgId)}`;
  const tabs = PI_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    to: `${basePath}/${tab.id}`,
    disabled: tab.id === "sessions" && !isConfigured && activeTab !== "sessions",
    active: tab.id === activeTab,
  }));

  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Pi sessions for {workspaceLabel}</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bo-product-code">SES</span>
            <BackofficeBreadcrumbs items={breadcrumbs} />
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:max-w-md">
            <BackofficeOrganisationScopeMenu
              activeOrganisationId={orgId}
              activeOrganisationLabel={workspaceLabel}
              options={organisationOptions}
              pathForOption={(option) =>
                `/backoffice/sessions/${encodeURIComponent(option.id)}/${activeTab}`
              }
              scopeLabel="Session scope"
            />
          </div>
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
        <OverflowTabRow items={tabs} ariaLabel="Pi workspace sections" />
      </div>
    </section>
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
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Sessions", to: "/backoffice/sessions" },
          { label: "Error" },
        ]}
        eyebrow="Agents"
        title="Pi sessions unavailable"
        description="The requested organisation session workspace could not be opened."
      />
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
