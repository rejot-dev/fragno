import { isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { BackofficeBreadcrumbs } from "@/components/backoffice/breadcrumbs";
import {
  BackofficeOrganisationScopeMenu,
  type BackofficeOrganisationScopeOption,
} from "@/components/backoffice/organisation-scope-menu";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";

export function FilesWorkspaceHeader({
  orgId,
  organisationName,
  organisationOptions,
}: {
  orgId: string;
  organisationName?: string | null;
  organisationOptions: BackofficeOrganisationScopeOption[];
}) {
  const workspaceLabel = organisationName ?? orgId;
  const basePath = `/backoffice/files/${encodeURIComponent(orgId)}`;

  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Files for {workspaceLabel}</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bo-product-code">FIL</span>
            <BackofficeBreadcrumbs
              items={[{ label: "Backoffice", to: "/backoffice" }, { label: "Files" }]}
            />
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:max-w-md">
            <BackofficeOrganisationScopeMenu
              activeOrganisationId={orgId}
              activeOrganisationLabel={workspaceLabel}
              options={organisationOptions}
              pathForOption={(option) => `/backoffice/files/${encodeURIComponent(option.id)}`}
              scopeLabel="File scope"
            />
          </div>
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
        <OverflowTabRow
          items={[{ id: "explorer", label: "Explorer", to: basePath, active: true }]}
          ariaLabel="File workspace sections"
        />
      </div>
    </section>
  );
}

export function FilesErrorBoundary({
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
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Files", to: "/backoffice/files" },
          { label: "Error" },
        ]}
        eyebrow="Workspace"
        title="File workspace unavailable"
        description="The requested organisation filesystem could not be opened."
      />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
