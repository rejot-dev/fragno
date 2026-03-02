import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/organisation-telegram-layout";
import { getOrganisation } from "./organisations.data";
import {
  TelegramErrorBoundary,
  TelegramHeader,
  TelegramTabs,
  type TelegramConfigState,
  type TelegramTab,
} from "./organisation-telegram-shared";
import { fetchTelegramConfig } from "./organisation-telegram-data";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const organisation = getOrganisation(params.orgId);
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
  const currentPath = matches[matches.length - 1]?.pathname || "";
  if (currentPath.includes("/telegram/messages")) {
    activeTab = "messages";
  } else if (currentPath.endsWith("/configuration")) {
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
