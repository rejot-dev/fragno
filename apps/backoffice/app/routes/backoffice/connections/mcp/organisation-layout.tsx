import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { throwOrganisationNotFound } from "../../route-errors";
import type { Route } from "./+types/organisation-layout";
import { fetchMcpConfig } from "./data";
import { McpErrorBoundary, McpHeader, McpTabs, type McpConfigState } from "./shared";

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

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throwOrganisationNotFound(params.orgId);
  }

  const { configState, configError } = await fetchMcpConfig(context, params.orgId);

  return {
    orgId: params.orgId,
    origin: new URL(request.url).origin,
    organisation,
    configState,
    configError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `MCP Setup · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <McpErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationMcpLayout({ loaderData }: Route.ComponentProps) {
  const {
    orgId,
    origin,
    organisation,
    configState: initialConfigState,
    configError: initialConfigError,
  } = loaderData;
  const [configState, setConfigState] = useState<McpConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

  return (
    <div className="space-y-4">
      <McpHeader orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <McpTabs
        orgId={orgId}
        activeTab="configuration"
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
