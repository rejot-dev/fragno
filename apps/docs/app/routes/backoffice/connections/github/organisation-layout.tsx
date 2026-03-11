import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/organisation-layout";
import {
  GitHubErrorBoundary,
  GitHubHeader,
  GitHubTabs,
  type GitHubAdminConfigState,
  type GitHubTab,
} from "./shared";
import { fetchGitHubAdminConfig } from "./data";
import { getAuthMe } from "@/fragno/auth-server";
import { buildBackofficeLoginPath } from "../../auth-navigation";

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
    throw new Response("Not Found", { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const { configState, configError } = await fetchGitHubAdminConfig(context, params.orgId, origin);

  return {
    orgId: params.orgId,
    origin,
    organisation,
    configState,
    configError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `GitHub Setup · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <GitHubErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationGitHubLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    orgId,
    origin,
    organisation,
    configState: initialConfigState,
    configError: initialConfigError,
  } = loaderData;
  const [configState, setConfigState] = useState<GitHubAdminConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

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
      <GitHubHeader orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <GitHubTabs
        orgId={orgId}
        activeTab={activeTab}
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
