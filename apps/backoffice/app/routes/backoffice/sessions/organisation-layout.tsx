import { Outlet } from "react-router";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

import { fetchAutomationAdapterIdentity } from "../automations/data.server";
import { automationScopeFromRouteParams } from "../automations/scope";
import type { Route } from "./+types/organisation-layout";
import { fetchPiAdapterIdentity, fetchPiRuntimeState } from "./data";
import { PiErrorBoundary, PiWorkspaceHeader, type PiLayoutContext } from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  const execution = await requireBackofficeContext(request, context, scope);

  const { runtimeState, runtimeError } = await fetchPiRuntimeState(context, scope);
  let persistenceSource: PiLayoutContext["persistenceSource"] = null;
  let persistenceError: string | null = null;
  let automationPersistenceSource: AutomationCollectionSource | null = null;
  let automationPersistenceError: string | null = null;
  if (runtimeState?.configured) {
    const [piAdapterIdentity, automationAdapterIdentity] = await Promise.allSettled([
      fetchPiAdapterIdentity(request, context, scope),
      fetchAutomationAdapterIdentity(request, context, scope),
    ]);
    if (piAdapterIdentity.status === "fulfilled") {
      persistenceSource = { scope, adapterIdentity: piAdapterIdentity.value };
    } else {
      persistenceError =
        piAdapterIdentity.reason instanceof Error
          ? piAdapterIdentity.reason.message
          : "Failed to load Pi session persistence.";
    }
    if (automationAdapterIdentity.status === "fulfilled") {
      automationPersistenceSource = { scope, adapterIdentity: automationAdapterIdentity.value };
    } else {
      automationPersistenceError =
        automationAdapterIdentity.reason instanceof Error
          ? automationAdapterIdentity.reason.message
          : "Failed to load workflow synchronization.";
    }
  }

  return {
    scope,
    scopeLabel:
      execution.scope.kind === "system" ? "System" : backofficeContextScopeRoutePath(scope),
    persistenceSource,
    persistenceError,
    automationPersistenceSource,
    automationPersistenceError,
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

export const isPiSessionsPath = (
  scope: Parameters<typeof backofficeContextScopeRoutePath>[0],
  pathname: string,
) => {
  const sessionsBasePath = `/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions`;
  const normalizedPath = pathname.replace(/\/+$/, "");
  return normalizedPath === sessionsBasePath || normalizedPath.startsWith(`${sessionsBasePath}/`);
};

export default function BackofficeScopedPiLayout({ loaderData, matches }: Route.ComponentProps) {
  const {
    scope,
    scopeLabel,
    persistenceSource,
    persistenceError,
    automationPersistenceSource,
    automationPersistenceError,
    runtimeState,
    runtimeError,
  } = loaderData;

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
            automationPersistenceSource,
            automationPersistenceError,
            runtimeState,
            runtimeError,
          }}
        />
      </div>
    </div>
  );
}
