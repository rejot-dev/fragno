import {
  backofficeScopeRootOwner,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { backofficeContextScopeLabel } from "@/backoffice-runtime/context";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { fetchPiManagerAvailableModels } from "./data";

/** What every agent conversation in the route's scope needs besides the agent itself. */
export async function loadPiLayoutData(request: Request, context: Readonly<RouterContextProvider>) {
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
