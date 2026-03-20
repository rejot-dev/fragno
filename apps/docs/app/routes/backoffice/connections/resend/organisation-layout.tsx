import { useEffect, useState } from "react";
import { Outlet, redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { throwOrganisationNotFound } from "../../route-errors";
import type { Route } from "./+types/organisation-layout";
import { fetchResendConfig } from "./data";
import {
  ResendErrorBoundary,
  ResendHeader,
  ResendTabs,
  type ResendConfigState,
  type ResendTab,
} from "./shared";

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

  const { configState, configError } = await fetchResendConfig(context, params.orgId);
  const url = new URL(request.url);
  const currentPath = url.pathname.replace(/\/+$/, "");
  const basePath = `/backoffice/connections/resend/${params.orgId}`;
  if (currentPath === basePath) {
    const target = configState?.configured ? "threads" : "configuration";
    return redirect(`${basePath}/${target}`);
  }

  return {
    orgId: params.orgId,
    origin: new URL(request.url).origin,
    organisation,
    configState,
    configError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const orgId = loaderData?.orgId ?? "organisation";
  return [{ title: `Resend Setup · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <ResendErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationResendLayout({
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
  const [configState, setConfigState] = useState<ResendConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  const resendIndex = pathSegments.lastIndexOf("resend");
  const activeSegment = resendIndex >= 0 ? pathSegments[resendIndex + 2] : undefined;

  let activeTab: ResendTab = "configuration";
  switch (activeSegment) {
    case "threads":
      activeTab = "threads";
      break;
    case "incoming":
      activeTab = "incoming";
      break;
    case "outgoing":
    case "outgoings":
    case "outbox":
      activeTab = "outgoing";
      break;
    case "domains":
      activeTab = "domains";
      break;
    case "configuration":
      activeTab = "configuration";
      break;
    default:
      break;
  }

  return (
    <div className="space-y-4">
      <ResendHeader orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <ResendTabs
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
