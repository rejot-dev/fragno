import { useEffect, useState } from "react";
import { Outlet, redirect } from "react-router";

import { selectIntegrationScope } from "../../integrations/connection.server";
import { IntegrationServiceHeader } from "../../integrations/service-header";
import type { Route } from "./+types/organization-layout";
import { resendConnection } from "./connection.server";
import { ResendErrorBoundary, ResendTabs, type ResendConfigState, type ResendTab } from "./shared";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const connection = resendConnection.require({ request, context });
  const { configState, configError } = await connection.configuration();
  const { basePath } = connection;
  if (url.pathname.replace(/\/+$/, "") === basePath) {
    const target = configState?.configured ? "threads" : "configuration";
    return redirect(`${basePath}/${target}`);
  }

  return {
    ...selectIntegrationScope(context, connection),
    origin: url.origin,
    organization:
      connection.resolvedScope.kind === "org" ? connection.resolvedScope.organization : null,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "scope";
  return [{ title: `Resend Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <ResendErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationResendLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    origin,
    organization,
    scope,
    uiScope,
    label,
    basePath,
    integrationsPath,
    scopeSegment,
    configState: initialConfigState,
    configError: initialConfigError,
  } = loaderData;
  const [configState, setConfigState] = useState<ResendConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, scopeSegment]);

  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);

  let activeTab: ResendTab = "configuration";
  if (pathSegments.includes("threads")) {
    activeTab = "threads";
  } else if (pathSegments.includes("incoming")) {
    activeTab = "incoming";
  } else if (
    pathSegments.includes("outgoing") ||
    pathSegments.includes("outgoings") ||
    pathSegments.includes("outbox")
  ) {
    activeTab = "outgoing";
  } else if (pathSegments.includes("domains")) {
    activeTab = "domains";
  }

  return (
    <div>
      <IntegrationServiceHeader
        integrationsPath={integrationsPath}
        service="Resend"
        scopeLabel={uiScope.label}
        subnav={
          <ResendTabs
            basePath={basePath}
            activeTab={activeTab}
            isConfigured={Boolean(configState?.configured)}
          />
        }
      />
      <Outlet
        context={{
          origin,
          organization,
          scope,
          scopeSegment,
          label,
          basePath,
          integrationsPath,
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
