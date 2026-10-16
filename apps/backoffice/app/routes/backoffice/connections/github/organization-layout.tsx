import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import { resolveIntegrationContext } from "../../integrations/scope.server";
import { IntegrationServiceHeader } from "../../integrations/service-header";
import type { Route } from "./+types/organization-layout";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  gitHubRepositoriesRouteAvailable,
} from "./data";
import {
  GitHubErrorBoundary,
  GitHubTabs,
  type GitHubAdminConfigState,
  type GitHubTab,
} from "./shared";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const integration = resolveIntegrationContext({
    context,
    integration: "github",
    allowedScopes: ["org"],
  });
  const organizationId = backofficeScopeOrganization(integration.scope)?.orgId ?? null;
  if (!organizationId) {
    throw new Response("Not Found", { status: 404 });
  }
  const organization =
    me.organizations.find((entry) => entry.organization.id === organizationId)?.organization ??
    null;

  const origin = url.origin;
  const { configState, configError } = await fetchGitHubAdminConfig(
    context,
    organizationId,
    origin,
  );
  const linkedRepositories = configState?.configured
    ? await fetchGitHubLinkedRepositories(request, context, organizationId)
    : null;
  const repositoriesEnabled = linkedRepositories
    ? gitHubRepositoriesRouteAvailable(linkedRepositories)
    : false;

  return {
    ...integration,
    organizationId,
    origin,
    organization,
    configState,
    configError,
    repositoriesEnabled,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "organization";
  return [{ title: `GitHub Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <GitHubErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganizationGitHubLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    organizationId,
    origin,
    organization,
    uiScope,
    basePath,
    integrationsPath,
    scopeSegment,
    configState: initialConfigState,
    configError: initialConfigError,
    repositoriesEnabled,
  } = loaderData;
  const [configState, setConfigState] = useState<GitHubAdminConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, scopeSegment]);

  let activeTab: GitHubTab = "configuration";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  if (pathSegments.includes("repositories")) {
    activeTab = "repositories";
  } else if (pathSegments.includes("configuration")) {
    activeTab = "configuration";
  }

  return (
    <div>
      <IntegrationServiceHeader
        integrationsPath={integrationsPath}
        service="GitHub"
        scopeLabel={uiScope.label}
        subnav={
          <GitHubTabs
            basePath={basePath}
            activeTab={activeTab}
            repositoriesEnabled={repositoriesEnabled}
          />
        }
      />
      <Outlet
        context={{
          organizationId,
          origin,
          organization,
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
