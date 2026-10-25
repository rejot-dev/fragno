import { Callout } from "@fragno-private/design-system/callout";
import { Outlet } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organization-layout";
import {
  OrganizationErrorBoundary,
  OrganizationTabs,
  organizationPageBodyClassName,
} from "./organization-shared";
import type { OrganizationTab } from "./organization-utils";
import { throwBackofficeOrganizationNotFound } from "./route-errors";

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!params.orgSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  const { me } = getBackofficeShellRequest(context);

  const entry = me.organizations.find((item) => item.organization.slug === params.orgSlug) ?? null;
  if (!entry) {
    throwBackofficeOrganizationNotFound(params.orgSlug);
  }

  const relations = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.auth.singleton()
    .commands.getOrganizationRelations({ organizationId: entry.organization.id });

  return {
    organization: entry.organization,
    membership: entry,
    me,
    relations:
      entry.through.kind === "membership"
        ? relations
        : // Managing reaches one organization deep, so the ones this one manages are not theirs.
          { ...relations, managedOrganizations: [] },
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const organizationName =
    loaderData?.organization?.name ?? loaderData?.organization?.id ?? "Organization";
  return [{ title: `Organization · ${organizationName}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <OrganizationErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const { organization, membership, me, relations } = loaderData;

  let activeTab: OrganizationTab = "overview";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  if (pathSegments.includes("members")) {
    activeTab = "members";
  } else if (pathSegments.includes("invites")) {
    activeTab = "invites";
  } else if (pathSegments.includes("clients")) {
    activeTab = "clients";
  } else if (pathSegments.includes("billing")) {
    activeTab = "billing";
  }

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Organization {organization.name || organization.id}</h1>
      <OrganizationTabs
        orgSlug={organization.slug}
        activeTab={activeTab}
        managed={membership.through.kind === "managing-organization"}
        managesClients={relations.managedOrganizations.length > 0}
      />
      <div className={organizationPageBodyClassName}>
        {membership.through.kind === "managing-organization" ? (
          <Callout tone="info" title={`Managed by ${membership.through.organization.name}`}>
            You act in {organization.name} through {membership.through.organization.name}, as{" "}
            {membership.roles.includes("admin") ? "an admin" : "a member"}. {organization.name}
            &rsquo;s own owners and admins manage its name, members, and invitations.
          </Callout>
        ) : null}
        <Outlet context={{ organization, membership, me, relations }} />
      </div>
    </div>
  );
}

export type OrganizationLayoutContext = {
  organization: Route.ComponentProps["loaderData"]["organization"];
  membership: Route.ComponentProps["loaderData"]["membership"];
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
  relations: Route.ComponentProps["loaderData"]["relations"];
};
