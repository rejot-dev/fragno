import { useEffect, useState } from "react";
import { Outlet, redirect, useLoaderData, useMatches, type LoaderFunctionArgs } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import type { UploadAdminConfigResponse } from "@/fragno/upload";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { throwOrganisationNotFound } from "../../route-errors";
import { fetchUploadConfig } from "./data";
import type { UploadLayoutContext } from "./layout-context";
import { resolveUploadWorkspaceTab } from "./organisation-layout-state";
import { UploadErrorBoundary, UploadHeader, UploadWorkspaceTabs } from "./shared";

export async function loader({ request, params, context, url }: LoaderFunctionArgs) {
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
  let persistenceSource: UploadLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  if (configState?.configured) {
    try {
      const adapterIdentity = await fetchUploadAdapterIdentity(request, context, orgId);
      persistenceSource = { orgId, adapterIdentity };
    } catch (error) {
      persistenceError =
        error instanceof Error ? error.message : "Failed to load Upload file persistence.";
    }
  }

  const currentPath = url.pathname.replace(/\/+$/, "");
  const basePath = `/backoffice/connections/upload/${orgId}`;
  if (currentPath === basePath) {
    const target = configState?.configured ? "files" : "configuration";
    return redirect(`${basePath}/${target}`);
  }

  return {
    orgId,
    origin: url.origin,
    organisation,
    configState,
    configError,
    persistenceSource,
    persistenceError,
  };
}

export function meta({ loaderData }: { loaderData?: { orgId?: string } }) {
  const orgId = loaderData?.orgId ?? "organisation";
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
    persistenceSource,
    persistenceError,
  } = useLoaderData<typeof loader>();

  const [configState, setConfigState] = useState<UploadAdminConfigResponse | null>(
    initialConfigState,
  );
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
          persistenceSource,
          persistenceError,
          setConfigState,
          setConfigError,
        }}
      />
    </div>
  );
}
