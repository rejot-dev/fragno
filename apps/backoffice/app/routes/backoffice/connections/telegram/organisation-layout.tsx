import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { fetchAutomationProjects } from "../../automations/data.server";
import {
  createIntegrationScopeSwitchOptions,
  organizationIdFromScope,
  resolveIntegrationContext,
} from "../../integrations/scope";
import type { Route } from "./+types/organisation-layout";
import { fetchTelegramConfig } from "./data";
import {
  TelegramErrorBoundary,
  TelegramHeader,
  TelegramTabs,
  type TelegramConfigState,
  type TelegramTab,
} from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const integration = resolveIntegrationContext({ params, me, integration: "telegram" });
  const organizationForScope = organizationIdFromScope(integration.scope);
  const organisation = organizationForScope
    ? (me.organizations.find((entry) => entry.organization.id === organizationForScope)
        ?.organization ?? null)
    : null;

  const projectOrgId =
    organizationForScope ??
    me.activeOrganization?.organization.id ??
    me.organizations[0]?.organization.id;
  const projectsResult = projectOrgId
    ? await fetchAutomationProjects(request, context, projectOrgId)
    : { projects: [] };
  const scopeOptions = createIntegrationScopeSwitchOptions({
    me,
    projects: projectsResult.projects,
    projectOrgId: projectOrgId ?? "",
    integration: "telegram",
  });

  const { configState, configError } = await fetchTelegramConfig(context, integration.scope);

  return {
    ...integration,
    origin: new URL(request.url).origin,
    organisation,
    scopeOptions,
    configState,
    configError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const label = data?.label ?? "scope";
  return [{ title: `Telegram Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <TelegramErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationTelegramLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    origin,
    organisation,
    scope,
    label,
    basePath,
    integrationsPath,
    scopeSegment,
    scopeOptions,
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
      <TelegramHeader
        organisationName={organisation?.name ?? label}
        integrationsPath={integrationsPath}
        scopeOptions={scopeOptions}
      />
      <TelegramTabs
        basePath={basePath}
        activeTab={activeTab}
        isConfigured={Boolean(configState?.configured)}
      />
      <Outlet
        context={{
          origin,
          organisation,
          scope,
          scopeSegment,
          label,
          basePath,
          integrationsPath,
          scopeOptions,
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
