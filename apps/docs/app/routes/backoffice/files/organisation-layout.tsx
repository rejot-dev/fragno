import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/organisation-layout";
import { createBackofficeFilesFileSystem } from "./data";
import { FilesErrorBoundary, FilesHeader } from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const returnTo = `${requestUrl.pathname}${requestUrl.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirectToLogin(request.url, returnTo);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const resolvedFileSystem = await createBackofficeFilesFileSystem({
    request,
    context,
    orgId: params.orgId,
  });

  return {
    orgId: params.orgId,
    origin: requestUrl.origin,
    organisation,
    mountCount: resolvedFileSystem.mounts.length,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const organisationName = data?.organisation?.name ?? data?.orgId ?? "Organisation";
  return [{ title: `Files · ${organisationName}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeFilesOrganisationLayout({ loaderData }: Route.ComponentProps) {
  const { orgId, origin, organisation, mountCount } = loaderData;

  return (
    <div className="space-y-4">
      <FilesHeader orgId={orgId} organisationName={organisation.name} mountCount={mountCount} />
      <Outlet
        context={{
          orgId,
          origin,
          organisation,
          mountCount,
        }}
      />
    </div>
  );
}

function redirectToLogin(requestUrl: string, returnTo: string) {
  return Response.redirect(new URL(buildBackofficeLoginPath(returnTo), requestUrl), 302);
}
