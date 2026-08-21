import { Outlet, redirect } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { lookupAutomationProject } from "../automations/data.server";
import {
  automationScopeFromRouteParams,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "../automations/scope";
import type { Route } from "./+types/scope-layout";
import type { FilesLayoutContext } from "./layout-context";
import { FilesErrorBoundary } from "./shared";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const returnTo = `${url.pathname}${url.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(returnTo));
  }

  const organisations = me.organizations.map((entry) => entry.organization);
  const parsedScope = automationScopeFromRouteParams(params);
  const projectLookup =
    parsedScope.kind === "project"
      ? await lookupAutomationProject(context, parsedScope.orgId, parsedScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw new Response(projectLookup.message, { status: 502 });
  }
  if (projectLookup?.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    project: projectLookup?.status === "found" ? projectLookup.project : null,
    user: me.user,
  });
  return {
    origin: url.origin,
    selectedScope,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Files · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeFilesScopeLayout({ loaderData }: Route.ComponentProps) {
  const outletContext = {
    scope: toBackofficeScope(loaderData.selectedScope),
    selectedScope: loaderData.selectedScope,
    origin: loaderData.origin,
  } satisfies FilesLayoutContext;

  return (
    <div className="flex h-[calc(100dvh-6.75rem)] min-h-0 flex-col gap-4 overflow-hidden sm:h-[calc(100dvh-4rem)]">
      <h1 className="sr-only">Files for {loaderData.selectedScope.label}</h1>
      <Outlet context={outletContext} />
    </div>
  );
}
