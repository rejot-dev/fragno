import { Outlet, redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { uploadConnection } from "./connection.server";
import type { UploadLayoutContext } from "./layout-context";
import { UploadErrorBoundary, UploadHeader } from "./shared";

export async function loader({ request, context, url }: LoaderFunctionArgs) {
  const connection = uploadConnection.require({ request, context });
  const { scope, basePath } = connection;
  if (url.pathname.replace(/\/+$/, "") === basePath) {
    return redirect(`${basePath}/files`);
  }

  let persistenceSource: UploadLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  try {
    const adapterIdentity = await fetchUploadAdapterIdentity(request, context, scope);
    persistenceSource = { scope, adapterIdentity };
  } catch (error) {
    persistenceError =
      error instanceof Error ? error.message : "Failed to load Upload file persistence.";
  }

  return {
    origin: url.origin,
    organization: connection.resolvedScope.organization,
    persistenceSource,
    persistenceError,
  };
}

export function meta({ loaderData }: { loaderData?: { organization?: { id: string } } }) {
  const organizationId = loaderData?.organization?.id ?? "organization";
  return [{ title: `Upload · ${organizationId}` }];
}

export function ErrorBoundary({ error, params }: { error: unknown; params: { orgSlug?: string } }) {
  return <UploadErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationUploadLayout() {
  const { origin, organization, persistenceSource, persistenceError } =
    useLoaderData<typeof loader>();

  return (
    <div className="space-y-4">
      <UploadHeader organizationLabel={organization.name || organization.id} />
      <Outlet
        context={
          {
            origin,
            organization,
            persistenceSource,
            persistenceError,
          } satisfies UploadLayoutContext
        }
      />
    </div>
  );
}
