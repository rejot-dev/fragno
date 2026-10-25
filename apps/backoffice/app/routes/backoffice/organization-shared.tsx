import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { isRouteErrorResponse } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";

import type { ActionNotice, OrganizationTab } from "./organization-utils";
import { getRouteErrorMessage, getBackofficeOrganizationNotFound } from "./route-errors";

/** The pages under an organization's tabs share this body, so each one starts where the others do. */
export const organizationPageBodyClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;

export function Notice({ notice }: { notice: ActionNotice }) {
  if (!notice) {
    return null;
  }

  if (notice.type === "error") {
    return <InlineAlert>{notice.message}</InlineAlert>;
  }
  return (
    <p role="status" className="text-xs text-[var(--bo-live)]">
      {notice.message}
    </p>
  );
}

/**
 * Better Auth lets only an organization's own members invite to it, so someone who acts in it
 * through the organization that manages it has no invites to manage.
 */
export function OrganizationTabs({
  orgSlug,
  activeTab,
  managed,
}: {
  orgSlug: string;
  activeTab: OrganizationTab | null;
  managed: boolean;
}) {
  const basePath = `/backoffice/organizations/${encodeURIComponent(orgSlug)}`;
  const tabs = [
    { id: "overview" as const, label: "Overview", to: basePath },
    { id: "members" as const, label: "Members", to: `${basePath}/members` },
    { id: "invites" as const, label: "Invites", to: `${basePath}/invites` },
    { id: "billing" as const, label: "Billing", to: `${basePath}/billing` },
  ];

  return (
    <BackofficeTabHeader
      items={tabs
        .filter((tab) => !managed || tab.id !== "invites")
        .map((tab) => ({ ...tab, active: tab.id === activeTab }))}
      ariaLabel="Organization management tabs"
      trailing={null}
      options={null}
    />
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
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
  }

  let message = getRouteErrorMessage(error, "An unexpected error occurred.");
  if (statusCode === 404 && params.orgSlug && getBackofficeOrganizationNotFound(error)) {
    message = `Organization '${params.orgSlug}' could not be found.`;
  }

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Organization unavailable</h1>
      {/* Without the loader's data, the error does not say how the user reaches the organization. */}
      {params.orgSlug ? (
        <OrganizationTabs orgSlug={params.orgSlug} activeTab={null} managed={false} />
      ) : null}
      <div className={organizationPageBodyClassName}>
        <BackofficeSystemState
          tone="error"
          label={`${statusCode} · ${statusText}`}
          title={message}
        />
      </div>
    </div>
  );
}
