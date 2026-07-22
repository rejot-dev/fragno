import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import type { PiConfigState } from "@/fragno/pi/pi-shared";

import { throwOrganisationNotFound } from "../route-errors";
import type { Route } from "./+types/organisation-layout";
import { fetchPiAdapterIdentity, fetchPiConfig } from "./data";
import { PiErrorBoundary, PiHeader, PiTabs, type PiLayoutContext, type PiTab } from "./shared";

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
  if (configState?.configured) {
    try {
      const adapterIdentity = await fetchPiAdapterIdentity(request, context, scope);
      persistenceSource = { scope, adapterIdentity };
    } catch (error) {
      persistenceError =
        error instanceof Error ? error.message : "Failed to load Pi session persistence.";
    }
  }

  return {
    scope,
    organisation,
    persistenceSource,
    persistenceError,
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
      className={isSessions ? "flex h-full min-h-0 flex-col gap-4 overflow-hidden" : "space-y-4"}
    >
      <PiHeader orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <PiTabs orgId={orgId} activeTab={activeTab} isConfigured={Boolean(configState?.configured)} />
      <div
        className={
          isSessions
            ? "flex h-[calc(100dvh-256px)] max-h-[calc(100dvh-256px)] min-h-0 flex-1 flex-col"
            : undefined
        }
      >
        <Outlet
          context={{
            scope,
            persistenceSource,
            persistenceError,
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
