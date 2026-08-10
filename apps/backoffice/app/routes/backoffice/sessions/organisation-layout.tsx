import { Outlet } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";

import { automationScopeFromRouteParams } from "../automations/scope";
import type { Route } from "./+types/organisation-layout";
import { fetchPiAdapterIdentity, fetchPiRuntimeState } from "./data";
import { isPiSessionsPath } from "./path";
import { PiErrorBoundary, PiWorkspaceHeader, type PiLayoutContext } from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  const execution = await requireBackofficeContext(request, context, scope);

  const { runtimeState, runtimeError } = await fetchPiRuntimeState(context, scope);
  let persistenceSource: PiLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  if (runtimeState?.configured) {
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
    scopeLabel: backofficeContextScopeLabel(execution.scope),
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
  const { scope, scopeLabel, persistenceSource, persistenceError, runtimeState, runtimeError } =
    loaderData;

  const currentPath = matches[matches.length - 1]?.pathname ?? "";
  const isSessions = isPiSessionsPath(scope, currentPath);

  return (
    <div
      className={
        isSessions
          ? "flex h-[calc(100dvh-7.25rem)] min-h-0 flex-col gap-2 overflow-hidden sm:h-[calc(100dvh-5rem)]"
          : "space-y-4"
      }
    >
      <PiWorkspaceHeader scope={scope} scopeLabel={scopeLabel} />
      <div className={isSessions ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <Outlet
          context={{
            scope,
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
