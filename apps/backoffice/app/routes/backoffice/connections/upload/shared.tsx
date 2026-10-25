import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { isRouteErrorResponse } from "react-router";

import { getRouteErrorMessage, getBackofficeOrganizationNotFound } from "../../route-errors";

export function UploadHeader({ organizationLabel }: { organizationLabel: string }) {
  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Internals", to: "/backoffice/internals" },
        { label: "Upload", to: "/backoffice/connections/upload" },
        { label: organizationLabel },
      ]}
      eyebrow="Integrations"
      title={`Upload for ${organizationLabel}`}
      description="Browse, upload, and delete the organization's workspace files."
      actions={
        <ButtonLink variant="secondary" to="/backoffice/connections/upload">
          Back to Upload
        </ButtonLink>
      }
    />
  );
}

export function UploadErrorBoundary({
  error,
  params,
}: {
  error: unknown;
  params: { orgSlug?: string };
}) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
  }

  message = getRouteErrorMessage(error, message);

  if (statusCode === 404 && params.orgSlug && getBackofficeOrganizationNotFound(error)) {
    message = `Organization '${params.orgSlug}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <UploadHeader organizationLabel="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
