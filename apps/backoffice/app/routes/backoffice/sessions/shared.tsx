import { isRouteErrorResponse } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficePageHeader } from "@/components/backoffice";
import { BackofficeBreadcrumbs } from "@/components/backoffice/breadcrumbs";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";
import type { PiRuntimeState } from "@/fragno/pi/pi-shared";
import type { PiCollectionSource } from "@/fragno/pi/tanstack/browser-database";

import { getRouteErrorDebugDetails, getRouteErrorMessage } from "../route-errors";

export type PiLayoutContext = {
  scope: BackofficeContextScope;
  persistenceSource: PiCollectionSource | null;
  persistenceError: string | null;
  automationPersistenceSource: AutomationCollectionSource | null;
  automationPersistenceError: string | null;
  runtimeState: PiRuntimeState | null;
  runtimeError: string | null;
};

export type PiTab = "sessions";

const PI_WORKSPACE_BREADCRUMBS = [
  { label: "Backoffice", to: "/backoffice" },
  { label: "Sessions" },
];

export function PiWorkspaceHeader({
  scope,
  scopeLabel,
}: {
  scope: BackofficeContextScope;
  scopeLabel: string;
}) {
  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Pi sessions for {scopeLabel}</h1>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bo-product-code">SES</span>
            <BackofficeBreadcrumbs items={PI_WORKSPACE_BREADCRUMBS} />
          </div>
          <span className="font-mono text-xs text-[var(--bo-muted)]">
            {scope.kind} · {scopeLabel}
          </span>
        </div>
      </div>
    </section>
  );
}

export function PiErrorBoundary({ error }: { error: unknown; params: unknown }) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
  }

  message = getRouteErrorMessage(error, message);

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
        description="The requested session workspace could not be opened."
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
