import { useEffect, useState } from "react";
import { Outlet, redirect, useLoaderData, useMatches, type LoaderFunctionArgs } from "react-router";

import type { UploadAdminConfigResponse } from "@/fragno/upload";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { uploadConnection } from "./connection.server";
import type { UploadLayoutContext } from "./layout-context";
import { resolveUploadWorkspaceTab } from "./organization-layout-state";
import { UploadErrorBoundary, UploadHeader, UploadWorkspaceTabs } from "./shared";

export async function loader({ request, context, url }: LoaderFunctionArgs) {
  const connection = uploadConnection.require({ request, context });
  const { scope, basePath } = connection;
  const { configState, configError } = await connection.configuration();
  if (url.pathname.replace(/\/+$/, "") === basePath) {
    return redirect(`${basePath}/${configState?.configured ? "files" : "configuration"}`);
  }

  let persistenceSource: UploadLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  if (configState?.configured) {
    try {
      const adapterIdentity = await fetchUploadAdapterIdentity(request, context, scope);
      persistenceSource = { scope, adapterIdentity };
    } catch (error) {
      persistenceError =
        error instanceof Error ? error.message : "Failed to load Upload file persistence.";
    }
  }

  return {
    origin: url.origin,
    organization: connection.resolvedScope.organization,
    configState,
    configError,
    persistenceSource,
    persistenceError,
  };
}

export function meta({ loaderData }: { loaderData?: { organization?: { id: string } } }) {
  const organizationId = loaderData?.organization?.id ?? "organization";
  return [{ title: `Upload Setup · ${organizationId}` }];
}

export function ErrorBoundary({ error, params }: { error: unknown; params: { orgSlug?: string } }) {
  return <UploadErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationUploadLayout() {
  const {
    origin,
    organization,
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
  }, [initialConfigError, initialConfigState, organization.id]);

  const matches = useMatches();
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  const activeTab = resolveUploadWorkspaceTab(pathSegments);

  return (
    <div className="space-y-4">
      <UploadHeader organizationLabel={organization.name || organization.id} />
      <UploadWorkspaceTabs
        orgSlug={organization.slug}
        activeTab={activeTab}
        isConfigured={Boolean(configState?.configured)}
      />
      <Outlet
        context={{
          origin,
          organization,
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
