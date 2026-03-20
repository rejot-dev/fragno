import { useEffect, useState } from "react";
import { Outlet, redirect, useLoaderData, useMatches, type LoaderFunctionArgs } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { throwOrganisationNotFound } from "../../route-errors";
import { fetchUploadConfig } from "./data";
import { resolveUploadWorkspaceTab } from "./organisation-layout-state";
import {
  UploadErrorBoundary,
  UploadHeader,
  UploadWorkspaceTabs,
  type UploadConfigState,
} from "./shared";

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const orgId = params.orgId;
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === orgId)?.organization ?? null;
  if (!organisation) {
    throwOrganisationNotFound(orgId);
  }

  const { configState, configError } = await fetchUploadConfig(context, orgId);

  const currentPath = new URL(request.url).pathname.replace(/\/+$/, "");
  const basePath = `/backoffice/connections/upload/${orgId}`;
  if (currentPath === basePath) {
    const target = configState?.configured ? "files" : "configuration";
    return redirect(`${basePath}/${target}`);
  }

  return {
    orgId,
    origin: new URL(request.url).origin,
    organisation,
    configState,
    configError,
  };
}

export function meta({ data }: { data?: { orgId?: string } }) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `Upload Setup · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: { error: unknown; params: { orgId?: string } }) {
  return <UploadErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationUploadLayout() {
  const {
    orgId,
    origin,
    organisation,
    configState: initialConfigState,
    configError: initialConfigError,
  } = useLoaderData<typeof loader>();

  const [configState, setConfigState] = useState<UploadConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

  const matches = useMatches();
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  const activeTab = resolveUploadWorkspaceTab(pathSegments);

  return (
    <div className="space-y-4">
      <UploadHeader orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <UploadWorkspaceTabs
        orgId={orgId}
        activeTab={activeTab}
        isConfigured={Boolean(configState?.configured)}
      />
      <Outlet
        context={{
          orgId,
          origin,
          organisation,
          configState,
          configLoading,
          configError,
          setConfigState,
          setConfigError,
        }}
      />
    </div>
  );
}
