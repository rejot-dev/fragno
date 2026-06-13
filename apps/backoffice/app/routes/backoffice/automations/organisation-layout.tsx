import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { throwOrganisationNotFound } from "../route-errors";
import type { Route } from "./+types/organisation-layout";
import { fetchAutomationStoreEntries, loadAutomationWorkspaceData, toExternalId } from "./data";
import type { AutomationScriptItem, AutomationStoreItem } from "./shared";
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

  const url = new URL(request.url);
  const storePrefix = url.searchParams.get("prefix") ?? "";

  const [workspaceResult, storeResult] = await Promise.all([
    loadAutomationWorkspaceData({ context, orgId: params.orgId }),
    fetchAutomationStoreEntries(request, context, params.orgId),
  ]);

  const scripts = normalizeScripts(workspaceResult.scripts);
  const storeEntries = normalizeStoreEntries(storeResult.storeEntries);

  return {
    orgId: params.orgId,
    organisation,
    scripts,
    storeEntries,
    scriptsError: workspaceResult.scriptsError,
    storeEntriesError: storeResult.storeEntriesError,
    storePrefix,
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
  if (pathSegments.includes("store")) {
    activeTab = "store";
  }

  return (
    <div className="space-y-4">
      <AutomationHeader orgId={loaderData.orgId} organisationName={loaderData.organisation.name} />
      <AutomationTabs orgId={loaderData.orgId} activeTab={activeTab} />
      <Outlet context={loaderData} />
    </div>
  );
}
