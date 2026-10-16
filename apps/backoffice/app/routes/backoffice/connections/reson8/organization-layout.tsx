import { useState } from "react";
import { Outlet, redirect } from "react-router";

import { selectIntegrationScope } from "../../integrations/connection.server";
import { IntegrationServiceHeader } from "../../integrations/service-header";
import type { Route } from "./+types/organization-layout";
import { reson8Connection } from "./connection.server";
import { Reson8ErrorBoundary, Reson8Tabs, type Reson8ConfigState, type Reson8Tab } from "./shared";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const connection = reson8Connection.require({ request, context });
  const { configState, configError } = await connection.configuration();
  const { basePath } = connection;
  if (url.pathname.replace(/\/+$/, "") === basePath) {
    return redirect(`${basePath}/${configState?.configured ? "transcribe" : "configuration"}`);
  }

  return {
    ...selectIntegrationScope(context, connection),
    organization: connection.resolvedScope.organization,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "organization";
  return [{ title: `Reson8 Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <Reson8ErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationReson8Layout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const stateKey = JSON.stringify({
    scopeSegment: loaderData.scopeSegment,
    configState: loaderData.configState,
    configError: loaderData.configError,
  });

  return <Reson8LayoutContent key={stateKey} loaderData={loaderData} matches={matches} />;
}

function Reson8LayoutContent({
  loaderData,
  matches,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  matches: Route.ComponentProps["matches"];
}) {
  const {
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
  const [configState, setConfigState] = useState<Reson8ConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  let activeTab: Reson8Tab = "configuration";
  if (pathSegments.includes("transcribe")) {
    activeTab = "transcribe";
  } else if (pathSegments.includes("custom-models")) {
    activeTab = "custom-models";
  }

  return (
    <div>
      <IntegrationServiceHeader
        integrationsPath={integrationsPath}
        service="Reson8"
        scopeLabel={uiScope.label}
        subnav={
          <Reson8Tabs
            basePath={basePath}
            activeTab={activeTab}
            isConfigured={Boolean(configState?.configured)}
          />
        }
      />
      <Outlet
        context={{
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
