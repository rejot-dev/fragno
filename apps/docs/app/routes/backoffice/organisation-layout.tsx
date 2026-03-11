import { Outlet } from "react-router";
import type { Route } from "./+types/organisation-layout";
import { getAuthMe } from "@/fragno/auth-server";
import { buildBackofficeLoginPath } from "./auth-navigation";
import {
  OrganisationErrorBoundary,
  OrganisationHeader,
  OrganisationTabs,
  type OrganisationTab,
} from "./organisation-shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const entry = me.organizations.find((item) => item.organization.id === params.orgId) ?? null;
  if (!entry) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    orgId: params.orgId,
    organization: entry.organization,
    member: entry.member,
    me,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const organisationName = data?.organization?.name ?? data?.orgId ?? "Organisation";
  return [{ title: `Organisation · ${organisationName}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <OrganisationErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const { orgId, organization, member, me } = loaderData;

  let activeTab: OrganisationTab = "overview";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  if (pathSegments.includes("members")) {
    activeTab = "members";
  } else if (pathSegments.includes("invites")) {
    activeTab = "invites";
  }

  return (
    <div className="space-y-4">
      <OrganisationHeader orgId={orgId} organisationName={organization.name} />
      <OrganisationTabs orgId={orgId} activeTab={activeTab} />
      <Outlet context={{ orgId, organization, member, me }} />
    </div>
  );
}

export type OrganisationLayoutContext = {
  orgId: string;
  organization: Route.ComponentProps["loaderData"]["organization"];
  member: Route.ComponentProps["loaderData"]["member"];
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};
