import {
  backofficeScopeRootOwner,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Outlet, type ShouldRevalidateFunctionArgs } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organization-layout";
import { isPiConversationSubmission } from "./agent-conversation-submission";
import { fetchPiManagerAvailableModels } from "./data";
import { isPiAgentsPath } from "./path";
import { PiErrorBoundary, type PiLayoutContext } from "./shared";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { resolvedScope, execution } = requireRouteScope(context);

  const availableModelOptions = await fetchPiManagerAvailableModels(
    request,
    context,
    execution.scope,
  );

  const owner = backofficeScopeRootOwner(resolvedScope);
  const usageLabel =
    owner === null
      ? "System work"
      : owner.kind === "user"
        ? "Personal usage"
        : `Usage: ${owner.organization.name}`;

  return {
    resolvedScope,
    scopeLabel: backofficeContextScopeLabel(execution.scope),
    usageLabel,
    availableModelOptions,
    dictationMountRoute: context.get(BackofficeWorkerContext).runtime.reson8
      ? `/api/reson8/${backofficeScopePathSegment(execution.scope)}`
      : null,
  };
}

export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return isPiConversationSubmission(formData) ? false : defaultShouldRevalidate;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Agents · ${loaderData?.scopeLabel ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <PiErrorBoundary error={error} params={params} />;
}

export default function BackofficeScopedPiLayout({ loaderData, matches }: Route.ComponentProps) {
  const { resolvedScope, scopeLabel, usageLabel, availableModelOptions, dictationMountRoute } =
    loaderData;
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
        <Outlet
          context={
            {
              resolvedScope,
              usageLabel,
              availableModelOptions,
              dictationMountRoute,
            } satisfies PiLayoutContext
          }
        />
      </div>
    </div>
  );
}
