import { Outlet } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  getBackofficeShellRequest,
  requireRouteScope,
} from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/organization-layout";
import { fetchPiManagerAvailableModels } from "./data";
import { isPiAgentsPath } from "./path";
import { PiErrorBoundary } from "./shared";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);
  const { resolvedScope, execution } = requireRouteScope(context);

  const availableModelOptions = await fetchPiManagerAvailableModels(
    request,
    context,
    execution.scope,
  );

  const billingOrganization =
    resolvedScope.kind === "org" || resolvedScope.kind === "project"
      ? resolvedScope.organization
      : resolvedScope.kind === "user" || resolvedScope.kind === "system"
        ? (me.activeOrganization?.organization ?? null)
        : null;

  return {
    resolvedScope,
    scopeLabel: backofficeContextScopeLabel(execution.scope),
    billingOrganization,
    availableModelOptions,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Agents · ${loaderData?.scopeLabel ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <PiErrorBoundary error={error} params={params} />;
}

export default function BackofficeScopedPiLayout({ loaderData, matches }: Route.ComponentProps) {
  const { resolvedScope, scopeLabel, billingOrganization, availableModelOptions } = loaderData;
  const currentPath = matches[matches.length - 1]?.pathname ?? "";
  const isAgents = isPiAgentsPath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
    currentPath,
  );

  return (
    <div
      className={
        isAgents
          ? "flex h-[calc(100dvh-6.75rem)] min-h-0 flex-col gap-2 overflow-hidden sm:h-[calc(100dvh-4rem)]"
          : "space-y-4"
      }
    >
      <h1 className="sr-only">Agents for {scopeLabel}</h1>
      <div className={isAgents ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <Outlet context={{ resolvedScope, billingOrganization, availableModelOptions }} />
      </div>
    </div>
  );
}
