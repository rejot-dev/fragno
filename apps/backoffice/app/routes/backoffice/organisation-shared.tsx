import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import { cn } from "@/lib/utils";

import { getRouteErrorMessage, isOrganisationNotFoundError } from "./route-errors";

export type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];
export type BackofficeOrganisationMember = AuthMeData["organizations"][number]["member"];

export type OrganisationTab = "overview" | "members" | "invites";

export const ROLE_OPTIONS = ["member", "admin", "owner"] as const;

export type ActionNotice = {
  type: "success" | "error";
  message: string;
} | null;

export const formatDate = (value?: string | null) => {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
};

export const formatDateTime = (value?: string | null) => {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

export const formatRoles = (roles?: string[]) => {
  if (!roles || roles.length === 0) {
    return "member";
  }
  return roles.join(", ");
};

export const getErrorMessage = (error: unknown) => {
  if (!error) {
    return "Something went wrong.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: string }).message;
    if (message) {
      return message;
    }
  }
  return "Something went wrong.";
};

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

export function OrganisationHeader({
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
        { label: "Organisations", to: "/backoffice/organisations" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Directory"
      title={organisationName ?? orgId}
      description="Review organisation details, team members, and outstanding invitations."
      actions={
        <Link
          to="/backoffice/organisations"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          All organisations
        </Link>
      }
    />
  );
}

export function OrganisationTabs({
  orgId,
  activeTab,
}: {
  orgId: string;
  activeTab: OrganisationTab;
}) {
  const basePath = `/backoffice/organisations/${orgId}`;
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
  ];

  return (
    <div
      role="tablist"
      aria-label="Organisation management tabs"
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const className = isActive
          ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
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

export function OrganisationErrorBoundary({
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
  }

  message = getRouteErrorMessage(error, message);

  if (statusCode === 404 && params.orgId && isOrganisationNotFoundError(error)) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <OrganisationHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
