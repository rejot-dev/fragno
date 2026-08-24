import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { AutomationWorkspaceHeader } from "../../automations/shared";
import { organizationIdFromScope, resolveIntegrationContext } from "../../integrations/scope";
import type { Route } from "./+types/organization-layout";
import { fetchTelegramConfig } from "./data";
import {
  TelegramErrorBoundary,
  TelegramTabs,
  type TelegramConfigState,
  type TelegramTab,
} from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const integration = resolveIntegrationContext({ params, me, integration: "telegram" });
  const organizationForScope = organizationIdFromScope(integration.scope);
  const organization = organizationForScope
    ? (me.organizations.find((entry) => entry.organization.id === organizationForScope)
        ?.organization ?? null)
    : null;

  const { configState, configError } = await fetchTelegramConfig(context, integration.scope);

  return {
    ...integration,
    origin: url.origin,
    organization,
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
    <div className="space-y-4">
      <AutomationWorkspaceHeader
        selectedScope={uiScope}
        activeTab="integrations"
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
