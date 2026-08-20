import { useEffect, useState } from "react";
import { Outlet, redirect } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { AutomationWorkspaceHeader } from "../../automations/shared";
import { organizationIdFromScope, resolveIntegrationContext } from "../../integrations/scope";
import type { Route } from "./+types/organisation-layout";
import { fetchResendConfig } from "./data";
import { ResendErrorBoundary, ResendTabs, type ResendConfigState, type ResendTab } from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const integration = resolveIntegrationContext({
    params,
    me,
    integration: "resend",
    allowedScopes: ["org", "system"],
  });
  const organizationForScope = organizationIdFromScope(integration.scope);
  const organisation = organizationForScope
    ? (me.organizations.find((entry) => entry.organization.id === organizationForScope)
        ?.organization ?? null)
    : null;

  const { configState, configError } = await fetchResendConfig(context, integration.scope);
  const currentPath = url.pathname.replace(/\/+$/, "");
  const basePath = integration.basePath;
  if (currentPath === basePath) {
    const target = configState?.configured ? "threads" : "configuration";
    return redirect(`${basePath}/${target}`);
  }

  return {
    ...integration,
    origin: url.origin,
    organisation,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.label ?? "scope";
  return [{ title: `Resend Setup · ${label}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <ResendErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationResendLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const {
    origin,
    organisation,
    scope,
    uiScope,
    label,
    basePath,
    integrationsPath,
    scopeSegment,
    configState: initialConfigState,
    configError: initialConfigError,
  } = loaderData;
  const [configState, setConfigState] = useState<ResendConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, scopeSegment]);

  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);

  let activeTab: ResendTab = "configuration";
  if (pathSegments.includes("threads")) {
    activeTab = "threads";
  } else if (pathSegments.includes("incoming")) {
    activeTab = "incoming";
  } else if (
    pathSegments.includes("outgoing") ||
    pathSegments.includes("outgoings") ||
    pathSegments.includes("outbox")
  ) {
    activeTab = "outgoing";
  } else if (pathSegments.includes("domains")) {
    activeTab = "domains";
  }

  return (
    <div className="space-y-4">
      <AutomationWorkspaceHeader
        selectedScope={uiScope}
        activeTab="integrations"
        heading={`Resend setup for ${uiScope.label}`}
        subnav={
          <ResendTabs
            basePath={basePath}
            activeTab={activeTab}
            isConfigured={Boolean(configState?.configured)}
          />
        }
      />
      <Outlet
        context={{
          origin,
          organisation,
          scope,
          scopeSegment,
          label,
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
