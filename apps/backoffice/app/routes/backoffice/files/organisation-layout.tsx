import { Outlet } from "react-router";

import type { FileMountMetadata } from "@/files";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/organisation-layout";
import { createBackofficeFilesFileSystem } from "./data";
import type { FilesLayoutContext } from "./layout-context";
import { FilesErrorBoundary, FilesHeader } from "./shared";

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

  const resolvedFileSystem = await createBackofficeFilesFileSystem({
    request,
    context,
    orgId: params.orgId,
  });
  const mounts = resolvedFileSystem.mounts.map<FileMountMetadata>(({ fs: _fs, ...mount }) => mount);
  const hasUploadMounts = mounts.some((mount) => mount.kind === "upload");
  let uploadCollectionSource = null;
  let uploadCollectionError: string | null = null;

  if (hasUploadMounts) {
    try {
      const adapterIdentity = await fetchUploadAdapterIdentity(request, context, params.orgId);
      uploadCollectionSource = { orgId: params.orgId, adapterIdentity };
    } catch (error) {
      uploadCollectionError =
        error instanceof Error ? error.message : "Failed to open local file metadata.";
    }
  }

  return {
    orgId: params.orgId,
    origin: url.origin,
    organisation,
    mounts,
    uploadCollectionSource,
    uploadCollectionError,
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
  const { orgId, origin, organisation, mounts, uploadCollectionSource, uploadCollectionError } =
    loaderData;

  const outletContext = {
    orgId,
    origin,
    organisation,
    mounts,
    uploadCollectionSource,
    uploadCollectionError,
  } satisfies FilesLayoutContext;

  return (
    <div className="space-y-4">
      <FilesHeader orgId={orgId} organisationName={organisation.name} mountCount={mounts.length} />
      <Outlet context={outletContext} />
    </div>
  );
}

function redirectToLogin(requestUrl: string, returnTo: string) {
  return Response.redirect(new URL(buildBackofficeLoginPath(returnTo), requestUrl), 302);
}
