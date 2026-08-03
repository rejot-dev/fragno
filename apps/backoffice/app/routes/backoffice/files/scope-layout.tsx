import { Outlet, redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { fetchAutomationProjects } from "../automations/data.server";
import {
  automationScopeFromRouteParams,
  createAutomationScopeOptions,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "../automations/scope";
import type { Route } from "./+types/scope-layout";
import type { FilesLayoutContext } from "./layout-context";
import { filesScopeBasePath } from "./scope";
import { FilesErrorBoundary, FilesWorkspaceHeader } from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const returnTo = `${url.pathname}${url.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(returnTo));
  }

  const organisations = me.organizations.map((entry) => entry.organization);
  const parsedScope = automationScopeFromRouteParams(params);
  const selectedOrgId =
    parsedScope.kind === "org" || parsedScope.kind === "project" ? parsedScope.orgId : null;
  const projectOrgId =
    selectedOrgId ?? me.activeOrganization?.organization.id ?? organisations[0]?.id ?? null;
  const projectsResult = projectOrgId
    ? await fetchAutomationProjects(request, context, projectOrgId)
    : { projects: [], projectsError: null };
  if (parsedScope.kind === "project" && projectsResult.projectsError) {
    throw new Response(projectsResult.projectsError, { status: 502 });
  }

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    projects: projectsResult.projects,
    user: me.user,
  });
  return {
    origin: url.origin,
    selectedScope,
    scopeOptions: createAutomationScopeOptions({
      organisations,
      projects: projectsResult.projects,
      user: me.user,
      currentTab: "dashboard",
      projectOrgId,
      pathForScope: filesScopeBasePath,
    }),
    projectsError: projectsResult.projectsError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Files · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeFilesScopeLayout({ loaderData }: Route.ComponentProps) {
  const outletContext = {
    scope: toBackofficeScope(loaderData.selectedScope),
    selectedScope: loaderData.selectedScope,
    origin: loaderData.origin,
  } satisfies FilesLayoutContext;

  return (
    <div className="space-y-4">
      <FilesWorkspaceHeader
        selectedScope={loaderData.selectedScope}
        scopeOptions={loaderData.scopeOptions}
        projectsError={loaderData.projectsError}
      />
      <Outlet context={outletContext} />
    </div>
  );
}
