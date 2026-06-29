import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/scope-layout";
import {
  fetchAutomationProjects,
  fetchAutomationRoutes,
  fetchAutomationStoreEntries,
  loadAutomationWorkspaceData,
  toExternalId,
} from "./data.server";
import {
  automationScopeFromRouteParams,
  createAutomationScopeOptions,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "./scope";
import type { AutomationRouteItem, AutomationScriptItem, AutomationStoreItem } from "./shared";
import {
  AutomationErrorBoundary,
  AutomationHeader,
  AutomationScopePicker,
  AutomationTabs,
  type AutomationTab,
} from "./shared";

const normalizeScripts = (
  scripts: Awaited<ReturnType<typeof loadAutomationWorkspaceData>>["scripts"],
): AutomationScriptItem[] => {
  return scripts
    .map((script) => ({
      id: script.id,
      key: script.key,
      name: script.name,
      engine: script.engine,
      layer: script.layer,
      readOnly: script.readOnly,
      script: null,
      path: script.path,
      absolutePath: script.absolutePath,
      version: script.version,
      scriptLoadError: script.scriptLoadError ?? null,
      enabled: script.enabled,
    }))
    .sort(
      (left, right) =>
        left.layer.localeCompare(right.layer) ||
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path),
    );
};

const normalizeRoutes = (
  routes: Awaited<ReturnType<typeof fetchAutomationRoutes>>["routes"],
): AutomationRouteItem[] =>
  [...routes].sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );

const normalizeStoreEntries = (
  storedEntries: Awaited<ReturnType<typeof fetchAutomationStoreEntries>>["storeEntries"],
) => {
  const entries: AutomationStoreItem[] = storedEntries.map((entry, index) => ({
    id: toExternalId(entry.id) || `store-entry-${index}`,
    key: entry.key?.trim() || "—",
    value: entry.value?.trim() || "—",
    description: entry.description ?? null,
    category: Array.isArray(entry.category) ? entry.category : [],
    actor: entry.actor ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  }));

  return entries.sort((left, right) => left.key.localeCompare(right.key));
};

const currentTabFromPath = (pathname: string): AutomationTab => {
  const segments = pathname.replace(/\/+$/, "").split("/");
  if (segments.includes("terminal")) {
    return "terminal";
  }
  if (segments.includes("sandboxes")) {
    return "sandboxes";
  }
  if (segments.includes("mcp")) {
    return "mcp";
  }
  if (segments.includes("router")) {
    return "router";
  }
  if (segments.includes("api")) {
    return "api";
  }
  if (segments.includes("events-catalog")) {
    return "events-catalog";
  }
  if (segments.includes("events")) {
    return "events";
  }
  if (segments.includes("store")) {
    return "store";
  }
  if (segments.includes("scripts")) {
    return "scripts";
  }
  return "terminal";
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisations = me.organizations.map((entry) => entry.organization);
  let parsedRouteScope;
  try {
    parsedRouteScope = automationScopeFromRouteParams(params);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  const selectedRouteScope =
    parsedRouteScope?.kind === "project" || parsedRouteScope?.kind === "org"
      ? parsedRouteScope.orgId
      : undefined;
  const activeOrgId =
    selectedRouteScope ?? me.activeOrganization?.organization.id ?? organisations[0]?.id ?? null;
  if (!activeOrgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const projectsResult = await fetchAutomationProjects(request, context, activeOrgId);
  if (params.scopeKind === "project" && projectsResult.projectsError) {
    throw Response.json(
      {
        code: "AUTOMATION_PROJECTS_UNAVAILABLE",
        message: projectsResult.projectsError,
      },
      { status: 502, statusText: "Bad Gateway" },
    );
  }

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    projects: projectsResult.projects,
    user: me.user,
  });
  const backofficeScope = toBackofficeScope(selectedScope);
  const requestUrl = new URL(request.url);
  const currentTab = currentTabFromPath(requestUrl.pathname);

  const [workspaceResult, routesResult, storeResult] = await Promise.all([
    loadAutomationWorkspaceData({ request, context, scope: backofficeScope }),
    fetchAutomationRoutes(request, context, backofficeScope),
    fetchAutomationStoreEntries(request, context, backofficeScope),
  ]);

  return {
    orgId:
      selectedScope.kind === "org" || selectedScope.kind === "project"
        ? selectedScope.orgId
        : activeOrgId,
    organisation:
      organisations.find((organisation) => organisation.id === activeOrgId) ?? organisations[0],
    user: me.user,
    selectedScope,
    scopeOptions: createAutomationScopeOptions({
      organisations,
      projects: projectsResult.projects,
      user: me.user,
      currentTab,
      projectOrgId: activeOrgId,
    }),
    scripts: normalizeScripts(workspaceResult.scripts),
    routes: normalizeRoutes(routesResult.routes),
    storeEntries: normalizeStoreEntries(storeResult.storeEntries),
    scriptsError: workspaceResult.scriptsError,
    routesError: routesResult.routesError,
    storeEntriesError: storeResult.storeEntriesError,
    projectsError: projectsResult.projectsError,
    storePrefix: requestUrl.searchParams.get("prefix") ?? "",
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.selectedScope.label ?? "scope";
  return [{ title: `Automations · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <AutomationErrorBoundary error={error} params={params} />;
}

export default function BackofficeAutomationScopeLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const activeTab = currentTabFromPath(currentPath);

  return (
    <div className="space-y-4">
      <AutomationHeader selectedScope={loaderData.selectedScope} />
      <AutomationScopePicker
        selectedScope={loaderData.selectedScope}
        scopeOptions={loaderData.scopeOptions}
        projectsError={loaderData.projectsError}
      />
      <AutomationTabs selectedScope={loaderData.selectedScope} activeTab={activeTab} />
      <Outlet context={loaderData} />
    </div>
  );
}
