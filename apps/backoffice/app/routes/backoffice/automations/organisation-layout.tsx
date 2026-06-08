import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { throwOrganisationNotFound } from "../route-errors";
import type { Route } from "./+types/organisation-layout";
import { fetchAutomationIdentityBindings, loadAutomationWorkspaceData, toExternalId } from "./data";
import type { AutomationIdentityItem, AutomationScriptItem } from "./shared";
import {
  AutomationErrorBoundary,
  AutomationHeader,
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
      script: null,
      path: script.path,
      absolutePath: script.absolutePath,
      version: script.version,
      scriptLoadError: script.scriptLoadError ?? null,
      enabled: script.enabled,
    }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
};

const normalizeIdentityBindings = (
  storedBindings: Awaited<ReturnType<typeof fetchAutomationIdentityBindings>>["identityBindings"],
) => {
  const bindings: AutomationIdentityItem[] = storedBindings.map((binding, index) => ({
    id: toExternalId(binding.id) || `identity-binding-${index}`,
    source: binding.source?.trim() || "unknown",
    key: binding.key?.trim() || "—",
    value: binding.value?.trim() || "—",
    description: binding.description?.trim() || null,
    status: binding.status?.trim() || "linked",
    linkedAt: binding.linkedAt ?? null,
    createdAt: binding.createdAt ?? null,
    updatedAt: binding.updatedAt ?? null,
  }));

  return bindings.sort((left, right) => {
    const leftTime = left.linkedAt ? new Date(left.linkedAt).getTime() : 0;
    const rightTime = right.linkedAt ? new Date(right.linkedAt).getTime() : 0;
    return rightTime - leftTime;
  });
};

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
    throwOrganisationNotFound(params.orgId);
  }

  const [workspaceResult, identityResult] = await Promise.all([
    loadAutomationWorkspaceData({ context, orgId: params.orgId }),
    fetchAutomationIdentityBindings(request, context, params.orgId),
  ]);

  const scripts = normalizeScripts(workspaceResult.scripts);
  const identityBindings = normalizeIdentityBindings(identityResult.identityBindings);

  return {
    orgId: params.orgId,
    organisation,
    scripts,
    identityBindings,
    scriptsError: workspaceResult.scriptsError,
    identityBindingsError: identityResult.identityBindingsError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `Automations · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <AutomationErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationAutomationsLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);

  let activeTab: AutomationTab = "scripts";
  if (pathSegments.includes("identity")) {
    activeTab = "identity";
  }

  return (
    <div className="space-y-4">
      <AutomationHeader orgId={loaderData.orgId} organisationName={loaderData.organisation.name} />
      <AutomationTabs orgId={loaderData.orgId} activeTab={activeTab} />
      <Outlet context={loaderData} />
    </div>
  );
}
