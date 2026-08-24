import { useEffect, useState } from "react";
import { Outlet, redirect, useLoaderData, useMatches, type LoaderFunctionArgs } from "react-router";

import type { UploadAdminConfigResponse } from "@/fragno/upload";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { fetchUploadConfig } from "./data";
import type { UploadLayoutContext } from "./layout-context";
import { resolveUploadWorkspaceTab } from "./organization-layout-state";
import { requireUploadRouteOrganization } from "./organization.server";
import { UploadErrorBoundary, UploadHeader, UploadWorkspaceTabs } from "./shared";

export async function loader({ request, params, context, url }: LoaderFunctionArgs) {
  const { organization } = await requireUploadRouteOrganization(request, context, params.orgSlug);
  const orgId = organization.id;
  const orgSlug = organization.slug;

  const { configState, configError } = await fetchUploadConfig(context, orgId);
  let persistenceSource: UploadLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  if (configState?.configured) {
    try {
      const scope = { kind: "org" as const, orgId };
      const adapterIdentity = await fetchUploadAdapterIdentity(request, context, scope);
      persistenceSource = { scope, adapterIdentity };
    } catch (error) {
      persistenceError =
        error instanceof Error ? error.message : "Failed to load Upload file persistence.";
    }
  }

  const currentPath = url.pathname.replace(/\/+$/, "");
  const basePath = `/backoffice/connections/upload/${encodeURIComponent(orgSlug)}`;
  if (currentPath === basePath) {
    const target = configState?.configured ? "files" : "configuration";
    return redirect(`${basePath}/${target}`);
  }

  return {
    origin: url.origin,
    organization,
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
