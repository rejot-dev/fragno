import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";
import type { PiConfigState } from "@/fragno/pi/pi-shared";

import { fetchAutomationAdapterIdentity } from "../automations/data.server";
import { createOrganisationScopeOptions } from "../integrations/scope";
import { throwOrganisationNotFound } from "../route-errors";
import type { Route } from "./+types/organisation-layout";
import { fetchPiAdapterIdentity, fetchPiConfig } from "./data";
import { PiErrorBoundary, PiWorkspaceHeader, type PiLayoutContext, type PiTab } from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throwOrganisationNotFound(params.orgId);
  }

  const scope = { kind: "org" as const, orgId: params.orgId };
  const { configState, configError } = await fetchPiConfig(context, scope);
  let persistenceSource: PiLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  let automationPersistenceSource: AutomationCollectionSource | null = null;
  let automationPersistenceError: string | null = null;
  if (configState?.configured) {
    const [piAdapterIdentity, automationAdapterIdentity] = await Promise.allSettled([
      fetchPiAdapterIdentity(request, context, scope),
      fetchAutomationAdapterIdentity(request, context, scope),
    ]);
    if (piAdapterIdentity.status === "fulfilled") {
      persistenceSource = { scope, adapterIdentity: piAdapterIdentity.value };
    } else {
      persistenceError =
        piAdapterIdentity.reason instanceof Error
          ? piAdapterIdentity.reason.message
          : "Failed to load Pi session persistence.";
    }
    if (automationAdapterIdentity.status === "fulfilled") {
      automationPersistenceSource = {
        scope,
        adapterIdentity: automationAdapterIdentity.value,
      };
    } else {
      automationPersistenceError =
        automationAdapterIdentity.reason instanceof Error
          ? automationAdapterIdentity.reason.message
          : "Failed to load workflow synchronization.";
    }
  }

  return {
    scope,
    organisation,
    organisationOptions: createOrganisationScopeOptions(me.organizations),
    persistenceSource,
    persistenceError,
    automationPersistenceSource,
    automationPersistenceError,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const orgId = loaderData?.scope.orgId ?? "organisation";
  return [{ title: `Pi Sessions · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <PiErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationPiLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    scope,
    organisation,
    persistenceSource,
    persistenceError,
    automationPersistenceSource,
    automationPersistenceError,
    configState: initialConfigState,
    configError: initialConfigError,
  } = loaderData;
  const orgId = scope.orgId;
  const [configState, setConfigState] = useState<PiConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

  let activeTab: PiTab = "configuration";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  const orgIndex = pathSegments.lastIndexOf(orgId);
  const activeSegment =
    orgIndex >= 0 ? pathSegments[orgIndex + 1] : pathSegments[pathSegments.length - 1];
  if (activeSegment === "sessions") {
    activeTab = "sessions";
  } else if (activeSegment === "harnesses") {
    activeTab = "harnesses";
  } else if (activeSegment === "configuration") {
    activeTab = "configuration";
  }

  const isSessions = activeTab === "sessions";

  return (
    <div
      className={
        isSessions
          ? "flex h-[calc(100dvh-7.25rem)] min-h-0 flex-col gap-2 overflow-hidden sm:h-[calc(100dvh-5rem)]"
          : "space-y-4"
      }
    >
      <PiWorkspaceHeader
        orgId={orgId}
        organisationName={organisation?.name ?? orgId}
        organisationOptions={loaderData.organisationOptions}
        activeTab={activeTab}
      />
      <div className={isSessions ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <Outlet
          context={{
            scope,
            persistenceSource,
            persistenceError,
            automationPersistenceSource,
            automationPersistenceError,
            configState,
            configError,
            setConfigState,
            setConfigError,
          }}
        />
      </div>
    </div>
  );
}
