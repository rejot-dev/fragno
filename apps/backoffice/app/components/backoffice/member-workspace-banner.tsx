import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { backofficePageColumnClassName } from "@fragno-private/design-system/tab-header";
import { Link } from "react-router";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { AdministeredMember, BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { dashboardPath } from "@/routes/backoffice/dashboard/path";

import { administeredMemberName } from "./administered-member-name";

/**
 * Says whose personal workspace this is and why the user may work in it, on every page of it:
 * everything done here is done as that member, which nothing else on the page makes plain.
 */
export function MemberWorkspaceBanner({
  me,
  resolvedScope,
  administeredMember,
}: {
  me: BackofficeMeData | null;
  resolvedScope: BackofficeResolvedScope<Organization> | null;
  administeredMember: AdministeredMember | null;
}) {
  const owner = resolvedScope ? backofficeScopeRootOwner(resolvedScope) : null;
  if (
    !me ||
    !administeredMember ||
    owner?.kind !== "user" ||
    owner.userId !== administeredMember.userId ||
    owner.userId === me.user.id
  ) {
    return null;
  }

  const name = administeredMemberName(administeredMember);
  const organization = administeredMember.organization;
  const access =
    me.organizations.find((entry) => entry.organization.id === organization.id) ?? null;
  const role = access?.roles.includes("owner") ? "an owner" : "an admin";
  const through =
    access?.through.kind === "managing-organization"
      ? ` through ${access.through.organization.name}`
      : "";

  return (
    <aside role="status" data-tone="waiting" className="bo-status-tone bo-status-surface border-b">
      {/* Shares the page column, so the note starts where the page's tabs do. */}
      <div
        className={`${backofficePageColumnClassName} flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs leading-5 sm:px-6`}
      >
        <p className="min-w-0 flex-1 text-[var(--bo-fg)]">
          <span className="font-semibold">
            You are working in {name}&rsquo;s personal workspace
          </span>{" "}
          as {role} of {organization.name}
          {through}. What you do here, you do as {name}.
        </p>
        <Link
          to={dashboardPath({ kind: "org", orgSlug: organization.slug })}
          className="shrink-0 font-semibold underline-offset-2 hover:underline"
        >
          Back to {organization.name}
        </Link>
      </div>
    </aside>
  );
}
