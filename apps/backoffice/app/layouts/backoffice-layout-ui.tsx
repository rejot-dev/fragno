import { type ReactNode, useEffect } from "react";
import {
  Link,
  Outlet,
  isRouteErrorResponse,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import { BackofficePageHeader, BackofficeShell } from "@/components/backoffice";
import { writePreferredOrganization } from "@/fragno/auth/preferred-organization.client";
import {
  getBackofficeOrganizationNotFound,
  getRouteErrorDebugDetails,
  getRouteErrorMessage,
} from "@/routes/backoffice/route-errors";
import { BACKOFFICE_LAYOUT_ROUTE_ID } from "@/routes/backoffice/route-ids";

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
    resolvedScope,
    automationCollectionSource,
    projectCollectionSource,
  } = loaderData;

  useEffect(() => {
    writePreferredOrganization(me.activeOrganizationId);
  }, [me.activeOrganizationId]);
  return (
    <BackofficeShell
      me={me}
      resolvedScope={resolvedScope}
      accessTokenExpiresAt={accessTokenExpiresAt}
      automationCollectionSource={automationCollectionSource}
      projectCollectionSource={projectCollectionSource}
      isLoading={false}
    >
      {children ?? <Outlet context={{ me }} />}
    </BackofficeShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const layoutData = useRouteLoaderData<Route.ComponentProps["loaderData"]>(
    BACKOFFICE_LAYOUT_ROUTE_ID,
  );
  const isResponse = isRouteErrorResponse(error);
  const status = isResponse ? error.status : null;
  const organizationNotFound = getBackofficeOrganizationNotFound(error);
  const title = organizationNotFound
    ? "Organization not found"
    : status === 404
      ? "Page not found"
      : status
        ? "Request failed"
        : "Something went wrong";
  const description = getRouteErrorMessage(
    error,
    isResponse
      ? "The requested backoffice page could not be loaded."
      : "An unexpected error occurred while loading the backoffice.",
  );
  const debugDetails =
    import.meta.env.MODE === "development" ? getRouteErrorDebugDetails(error) : null;

  const currentOrganization =
    layoutData?.resolvedScope.kind === "org" || layoutData?.resolvedScope.kind === "project"
      ? layoutData.resolvedScope.organization
      : null;
  const currentOrganizationPath = currentOrganization
    ? `/backoffice/automations/org/${encodeURIComponent(currentOrganization.slug)}/dashboard`
    : null;

  return (
    <BackofficeShell
      me={layoutData?.me ?? null}
      resolvedScope={layoutData?.resolvedScope ?? null}
      accessTokenExpiresAt={layoutData?.accessTokenExpiresAt ?? null}
      automationCollectionSource={layoutData?.automationCollectionSource ?? null}
      projectCollectionSource={layoutData?.projectCollectionSource ?? null}
      isLoading={false}
    >
      <div className="space-y-4">
        <BackofficePageHeader
          breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Error" }]}
          eyebrow="Backoffice"
          title={title}
          description={
            organizationNotFound
              ? organizationNotFound.organizationSlug
                ? `The organization slug '${organizationNotFound.organizationSlug}' does not match an organization you can access.`
                : "The requested organization does not match an organization you can access."
              : description
          }
          actions={
            organizationNotFound ? (
              <div className="flex flex-wrap gap-2">
                {currentOrganizationPath ? (
                  <Link
                    to={currentOrganizationPath}
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Open current organization
                  </Link>
                ) : null}
                <Link
                  to="/backoffice/organizations"
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Choose organization
                </Link>
              </div>
            ) : (
              <Link
                to="/backoffice"
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              >
                Back to terminal
              </Link>
            )
          }
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
