import { Outlet } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/organization-layout";
import { buildBackofficeLoginPath } from "./auth-navigation";
import {
  OrganizationErrorBoundary,
  OrganizationHeader,
  OrganizationTabs,
} from "./organization-shared";
import type { OrganizationTab } from "./organization-utils";
import { throwBackofficeOrganizationNotFound } from "./route-errors";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (!params.orgSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const entry = me.organizations.find((item) => item.organization.slug === params.orgSlug) ?? null;
  if (!entry) {
    throwBackofficeOrganizationNotFound(params.orgSlug);
  }

  return {
    organization: entry.organization,
    member: entry.member,
    me,
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
  const { organization, member, me } = loaderData;

  let activeTab: OrganizationTab = "overview";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  if (pathSegments.includes("members")) {
    activeTab = "members";
  } else if (pathSegments.includes("invites")) {
    activeTab = "invites";
  } else if (pathSegments.includes("billing")) {
    activeTab = "billing";
  }

  return (
    <div className="space-y-4">
      <OrganizationHeader organizationLabel={organization.name || organization.id} />
      <OrganizationTabs orgSlug={organization.slug} activeTab={activeTab} />
      <Outlet context={{ organization, member, me }} />
    </div>
  );
}

export type OrganizationLayoutContext = {
  organization: Route.ComponentProps["loaderData"]["organization"];
  member: Route.ComponentProps["loaderData"]["member"];
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
