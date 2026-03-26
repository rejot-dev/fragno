import { useEffect, useState } from "react";
import { Outlet, redirect, useLoaderData, useMatches, type LoaderFunctionArgs } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { throwOrganisationNotFound } from "../../route-errors";
import { fetchReson8Config } from "./data";
import {
  Reson8ErrorBoundary,
  Reson8Header,
  Reson8Tabs,
  type Reson8ConfigState,
  type Reson8Tab,
} from "./shared";

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const orgId = params.orgId;
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === orgId)?.organization ?? null;
  if (!organisation) {
    throwOrganisationNotFound(orgId);
  }

  const { configState, configError } = await fetchReson8Config(context, orgId);
  const currentPath = new URL(request.url).pathname.replace(/\/+$/, "");
  const basePath = `/backoffice/connections/reson8/${orgId}`;
  if (currentPath === basePath) {
    return redirect(`${basePath}/${configState?.configured ? "transcribe" : "configuration"}`);
  }

  return {
    orgId,
    organisation,
    configState,
    configError,
  };
}

export function meta({ data }: { data?: { orgId?: string } }) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `Reson8 Setup · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: { error: unknown; params: { orgId?: string } }) {
  return <Reson8ErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationReson8Layout() {
  const {
    orgId,
    organisation,
    configState: initialConfigState,
    configError: initialConfigError,
  } = useLoaderData<typeof loader>();
  const [configState, setConfigState] = useState<Reson8ConfigState | null>(initialConfigState);
  const [configError, setConfigError] = useState<string | null>(initialConfigError);
  const configLoading = false;

  useEffect(() => {
    setConfigState(initialConfigState);
    setConfigError(initialConfigError);
  }, [initialConfigError, initialConfigState, orgId]);

  const matches = useMatches();
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);
  let activeTab: Reson8Tab = "configuration";
  if (pathSegments.includes("transcribe")) {
    activeTab = "transcribe";
  } else if (pathSegments.includes("custom-models")) {
    activeTab = "custom-models";
  }

  return (
    <div className="space-y-4">
      <Reson8Header orgId={orgId} organisationName={organisation?.name ?? orgId} />
      <Reson8Tabs
        orgId={orgId}
        activeTab={activeTab}
        isConfigured={Boolean(configState?.configured)}
      />
      <Outlet
        context={{
          orgId,
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
