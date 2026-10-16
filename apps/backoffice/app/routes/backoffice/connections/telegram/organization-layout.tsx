import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { selectIntegrationScope } from "../../integrations/connection.server";
import { IntegrationServiceHeader } from "../../integrations/service-header";
import type { Route } from "./+types/organization-layout";
import { telegramConnection } from "./connection.server";
import {
  TelegramErrorBoundary,
  TelegramTabs,
  type TelegramConfigState,
  type TelegramTab,
} from "./shared";

export async function loader({ request, context }: Route.LoaderArgs) {
  const connection = telegramConnection.require({ request, context });
  const { resolvedScope } = connection;
  const integration = selectIntegrationScope(context, connection);
  const { configState, configError } = await connection.configuration();

  return {
    ...integration,
    organization: backofficeScopeOrganization(resolvedScope)?.organization ?? null,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "scope";
  return [{ title: `Telegram Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <TelegramErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationTelegramLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
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
  const [configState, setConfigState] = useState<TelegramConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, scopeSegment]);

  let activeTab: TelegramTab = "configuration";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  if (pathSegments.includes("messages")) {
    activeTab = "messages";
  } else if (pathSegments.includes("configuration")) {
    activeTab = "configuration";
  }

  return (
    <div>
      <IntegrationServiceHeader
        integrationsPath={integrationsPath}
        service="Telegram"
        scopeLabel={uiScope.label}
        subnav={
          <TelegramTabs
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
