import { useEffect, useState } from "react";
import { Outlet, redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { AutomationWorkspaceHeader } from "../../automations/shared";
import {
  createIntegrationScopeSwitchOptions,
  integrationBasePath,
  resolveIntegrationContext,
} from "../../integrations/scope";
import type { Route } from "./+types/organisation-layout";
import { fetchReson8Config } from "./data";
import { Reson8ErrorBoundary, Reson8Tabs, type Reson8ConfigState, type Reson8Tab } from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
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
  const organisation =
    me.organizations.find((entry) => entry.organization.id === orgId)?.organization ?? null;
  const scopeOptions = createIntegrationScopeSwitchOptions({
    me,
    projects: [],
    projectOrgId: orgId,
    integration: "reson8",
    allowedScopes: ["org"],
  });

  const { configState, configError } = await fetchReson8Config(context, orgId);
  const currentPath = url.pathname.replace(/\/+$/, "");
  if (currentPath === integration.basePath) {
    return redirect(
      `${integration.basePath}/${configState?.configured ? "transcribe" : "configuration"}`,
    );
  }

  return {
    ...integration,
    orgId,
    organisation,
    scopeOptions,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "organisation";
  return [{ title: `Reson8 Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <Reson8ErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationReson8Layout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    orgId,
    organisation,
    scope,
    uiScope,
    label,
    basePath,
    integrationsPath,
    scopeSegment,
    scopeOptions,
    configState: initialConfigState,
    configError: initialConfigError,
  } = loaderData;
  const [configState, setConfigState] = useState<Reson8ConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, scopeSegment]);

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
        scopeOptions={scopeOptions}
        projectsError={null}
        activeTab="integrations"
        breadcrumbTail={[{ label: "Reson8" }]}
        subpage={{
          title: "Reson8",
          description: "Speech transcription, realtime capture, and custom vocabulary models.",
          pathForScope: (candidateScope) =>
            candidateScope.kind === "org" ? integrationBasePath(candidateScope, "reson8") : null,
          navigation: (
            <Reson8Tabs
              basePath={basePath}
              activeTab={activeTab}
              isConfigured={Boolean(configState?.configured)}
            />
          ),
        }}
      />
      <Outlet
        context={{
          orgId,
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
