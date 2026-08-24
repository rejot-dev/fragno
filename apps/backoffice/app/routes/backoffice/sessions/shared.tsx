import { isRouteErrorResponse } from "react-router";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { BackofficePageHeader } from "@/components/backoffice";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";
import type { PiRuntimeState } from "@/fragno/pi/pi-shared";

import { getRouteErrorDebugDetails, getRouteErrorMessage } from "../route-errors";

export type PiLayoutContext = {
  resolvedScope: BackofficeResolvedScope;
  billingOrganization: { id: string; name: string } | null;
  persistenceSource: AutomationCollectionSource | null;
  persistenceError: string | null;
  runtimeState: PiRuntimeState | null;
  runtimeError: string | null;
};

export type PiTab = "sessions";

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
