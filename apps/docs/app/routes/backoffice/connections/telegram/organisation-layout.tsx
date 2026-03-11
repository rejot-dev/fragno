import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/organisation-layout";
import {
  TelegramErrorBoundary,
  TelegramHeader,
  TelegramTabs,
  type TelegramConfigState,
  type TelegramTab,
} from "./shared";
import { fetchTelegramConfig } from "./data";
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

  const { configState, configError } = await fetchTelegramConfig(context, params.orgId);

  return {
    orgId: params.orgId,
    origin: new URL(request.url).origin,
    organisation,
    configState,
    configError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `Telegram Setup · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <TelegramErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationTelegramLayout({
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
  const [configState, setConfigState] = useState<TelegramConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

  let activeTab: TelegramTab = "configuration";
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  if (pathSegments.includes("messages")) {
    activeTab = "messages";
  } else if (pathSegments.includes("configuration")) {
    activeTab = "configuration";
  }

  return (
    <div className="space-y-4">
      <TelegramHeader orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <TelegramTabs
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
