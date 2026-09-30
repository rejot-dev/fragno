import { ButtonLink } from "@fragno-private/design-system/button";
import { cn } from "@fragno-private/design-system/cn";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Link, isRouteErrorResponse } from "react-router";

import type { ActionNotice, OrganizationTab } from "./organization-utils";
import { getRouteErrorMessage, getBackofficeOrganizationNotFound } from "./route-errors";

export function Notice({ notice }: { notice: ActionNotice }) {
  if (!notice) {
    return null;
  }

  const className =
    notice.type === "error"
      ? "border border-red-300 bg-red-50 text-red-700"
      : "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]";

  return <p className={cn("px-3 py-2 text-xs", className)}>{notice.message}</p>;
}

export function OrganizationHeader({ organizationLabel }: { organizationLabel: string }) {
  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Organizations", to: "/backoffice/organizations" },
        { label: organizationLabel },
      ]}
      eyebrow="Directory"
      title={organizationLabel}
      description="Review organization details, team access, invitations, and metered usage."
      actions={
        <ButtonLink variant="secondary" to="/backoffice/organizations">
          All organizations
        </ButtonLink>
      }
    />
  );
}

export function OrganizationTabs({
  orgSlug,
  activeTab,
}: {
  orgSlug: string;
  activeTab: OrganizationTab;
}) {
  const basePath = `/backoffice/organizations/${encodeURIComponent(orgSlug)}`;
  const tabs = [
    {
      id: "overview" as const,
      label: "Overview",
      to: basePath,
    },
    {
      id: "members" as const,
      label: "Members",
      to: `${basePath}/members`,
    },
    {
      id: "invites" as const,
      label: "Invites",
      to: `${basePath}/invites`,
    },
    {
      id: "billing" as const,
      label: "Billing",
      to: `${basePath}/billing`,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="Organization management tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const className = isActive
          ? "border border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-fg)]"
          : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

        return (
          <Link key={tab.id} to={tab.to} role="tab" aria-selected={isActive} className={className}>
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export function OrganizationErrorBoundary({
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
      <OrganizationHeader organizationLabel="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
