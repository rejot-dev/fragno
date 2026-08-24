import { useState } from "react";
import { Outlet, redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { AutomationWorkspaceHeader } from "../../automations/shared";
import { resolveIntegrationContext } from "../../integrations/scope";
import type { Route } from "./+types/organization-layout";
import { fetchReson8Config } from "./data";
import { Reson8ErrorBoundary, Reson8Tabs, type Reson8ConfigState, type Reson8Tab } from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const integration = resolveIntegrationContext({
    params,
    me,
    integration: "reson8",
    allowedScopes: ["org"],
  });
  if (integration.scope.kind !== "org") {
    throw new Response("Not Found", { status: 404 });
  }

  const orgId = integration.scope.orgId;
  const organization =
    me.organizations.find((entry) => entry.organization.id === orgId)?.organization ?? null;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }
  const { configState, configError } = await fetchReson8Config(context, orgId);
  const currentPath = url.pathname.replace(/\/+$/, "");
  if (currentPath === integration.basePath) {
    return redirect(
      `${integration.basePath}/${configState?.configured ? "transcribe" : "configuration"}`,
    );
  }

  return {
    ...integration,
    organization,
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
    <div className="space-y-4">
      <AutomationWorkspaceHeader
        selectedScope={uiScope}
        activeTab="integrations"
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
