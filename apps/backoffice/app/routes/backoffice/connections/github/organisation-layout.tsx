import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import {
  createIntegrationScopeSwitchOptions,
  organizationIdFromScope,
  resolveIntegrationContext,
} from "../../integrations/scope";
import type { Route } from "./+types/organisation-layout";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  gitHubRepositoriesRouteAvailable,
} from "./data";
import {
  GitHubErrorBoundary,
  GitHubHeader,
  GitHubTabs,
  type GitHubAdminConfigState,
  type GitHubTab,
} from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const integration = resolveIntegrationContext({
    params,
    me,
    integration: "github",
    allowedScopes: ["org"],
  });
  const organizationId = organizationIdFromScope(integration.scope);
  if (!organizationId) {
    throw new Response("Not Found", { status: 404 });
  }
  const organisation =
    me.organizations.find((entry) => entry.organization.id === organizationId)?.organization ??
    null;

  const projectOrgId =
    organizationId ??
    me.activeOrganization?.organization.id ??
    me.organizations[0]?.organization.id;
  const scopeOptions = createIntegrationScopeSwitchOptions({
    me,
    projects: [],
    projectOrgId: projectOrgId ?? "",
    integration: "github",
    allowedScopes: ["org"],
  });

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
    organisation,
    scopeOptions,
    configState,
    configError,
    repositoriesEnabled,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "organisation";
  return [{ title: `GitHub Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <GitHubErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationGitHubLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    organizationId,
    origin,
    organisation,
    label,
    basePath,
    integrationsPath,
    scopeSegment,
    scopeOptions,
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
    <div className="space-y-4">
      <GitHubHeader
        organisationName={organisation?.name ?? label}
        integrationsPath={integrationsPath}
        scopeOptions={scopeOptions}
      />
      <GitHubTabs
        basePath={basePath}
        activeTab={activeTab}
        repositoriesEnabled={repositoriesEnabled}
      />
      <Outlet
        context={{
          organizationId,
          origin,
          organisation,
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
