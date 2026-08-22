import type { ReactNode } from "react";
import { Outlet, isRouteErrorResponse, useRouteError } from "react-router";

import { BackofficePageHeader, BackofficeShell } from "@/components/backoffice";
import { getRouteErrorDebugDetails } from "@/routes/backoffice/route-errors";

import type { Route } from "./+types/backoffice-layout";

export default function BackofficeLayout({
  children,
  loaderData,
}: {
  children?: ReactNode;
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const {
    me,
    accessTokenExpiresAt,
    currentScope,
    automationCollectionSource,
    projectCollectionSource,
  } = loaderData;
  return (
    <BackofficeShell
      me={me}
      accessTokenExpiresAt={accessTokenExpiresAt}
      currentContext={{ scope: currentScope, automationCollectionSource, projectCollectionSource }}
      isLoading={false}
    >
      {children ?? <Outlet context={{ me }} />}
    </BackofficeShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const status = isResponse ? error.status : null;
  const title =
    status === 404 ? "Page not found" : status ? "Request failed" : "Something went wrong";
  const description = isResponse
    ? typeof error.data === "string"
      ? error.data
      : "The requested backoffice page could not be loaded."
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred while loading the backoffice.";
  const debugDetails =
    import.meta.env.MODE === "development" ? getRouteErrorDebugDetails(error) : null;

  return (
    <BackofficeShell me={null} accessTokenExpiresAt={null} currentContext={null} isLoading={false}>
      <div className="space-y-4">
        <BackofficePageHeader
          breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Error" }]}
          eyebrow="Backoffice"
          title={title}
          description={description}
        />
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          {status ? <p>Error code: {status}</p> : null}
          {debugDetails ? (
            <details className="mt-3" open>
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
    </BackofficeShell>
  );
}
