import { Outlet } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";

import type { Route } from "./+types/organization-layout";
import { fetchPiAdapterIdentity, fetchPiRuntimeState } from "./data";
import { isPiSessionsPath } from "./path";
import { PiErrorBoundary, type PiLayoutContext } from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const me = await requireBackofficeMe(request, context);
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  const resolvedScope = resolveBackofficeRouteScope(
    routeScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  const scope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const execution = await requireBackofficeContext(request, context, scope);

  const billingOrganization =
    resolvedScope.kind === "org" || resolvedScope.kind === "project"
      ? resolvedScope.organization
      : resolvedScope.kind === "user"
        ? (me.activeOrganization?.organization ?? null)
        : null;
  const { runtimeState, runtimeError } = await fetchPiRuntimeState(context, scope);
  let persistenceSource: PiLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  if (runtimeState?.configured) {
    try {
      const adapterIdentity = await fetchPiAdapterIdentity(request, context, scope);
      persistenceSource = { resolvedScope, adapterIdentity };
    } catch (error) {
      persistenceError =
        error instanceof Error ? error.message : "Failed to load Pi session persistence.";
    }
  }

  return {
    resolvedScope,
    scopeLabel: backofficeContextScopeLabel(execution.scope),
    billingOrganization,
    persistenceSource,
    persistenceError,
    runtimeState,
    runtimeError,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Pi Sessions · ${loaderData?.scopeLabel ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <PiErrorBoundary error={error} params={params} />;
}

export default function BackofficeScopedPiLayout({ loaderData, matches }: Route.ComponentProps) {
  const {
    resolvedScope,
    scopeLabel,
    billingOrganization,
    persistenceSource,
    persistenceError,
    runtimeState,
    runtimeError,
  } = loaderData;

  const currentPath = matches[matches.length - 1]?.pathname ?? "";
  const isSessions = isPiSessionsPath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
    currentPath,
  );

  return (
    <div
      className={
        isSessions
          ? "flex h-[calc(100dvh-6.75rem)] min-h-0 flex-col gap-2 overflow-hidden sm:h-[calc(100dvh-4rem)]"
          : "space-y-4"
      }
    >
      <h1 className="sr-only">Pi sessions for {scopeLabel}</h1>
      <div className={isSessions ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <Outlet
          context={{
            resolvedScope,
            billingOrganization,
            persistenceSource,
            persistenceError,
            runtimeState,
            runtimeError,
          }}
        />
      </div>
    </div>
  );
}
