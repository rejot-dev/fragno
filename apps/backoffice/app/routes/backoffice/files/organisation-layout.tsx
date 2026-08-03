import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { createOrganisationScopeOptions } from "../integrations/scope";
import type { Route } from "./+types/organisation-layout";
import type { FilesLayoutContext } from "./layout-context";
import { FilesErrorBoundary, FilesWorkspaceHeader } from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const returnTo = `${url.pathname}${url.search}`;

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirectToLogin(request.url, returnTo);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    orgId: params.orgId,
    origin: url.origin,
    organisation,
    organisationOptions: createOrganisationScopeOptions(me.organizations),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const organisationName = loaderData?.organisation?.name ?? loaderData?.orgId ?? "Organisation";
  return [{ title: `Files · ${organisationName}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeFilesOrganisationLayout({ loaderData }: Route.ComponentProps) {
  const { orgId, origin, organisation } = loaderData;

  const outletContext = {
    orgId,
    origin,
    organisation,
  } satisfies FilesLayoutContext;

  return (
    <div className="space-y-4">
      <FilesWorkspaceHeader
        orgId={orgId}
        organisationName={organisation.name}
        organisationOptions={loaderData.organisationOptions}
      />
      <Outlet context={outletContext} />
    </div>
  );
}

function redirectToLogin(requestUrl: string, returnTo: string) {
  return Response.redirect(new URL(buildBackofficeLoginPath(returnTo), requestUrl), 302);
}
