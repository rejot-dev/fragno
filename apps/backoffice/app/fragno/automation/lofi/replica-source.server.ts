import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";
import type { RouterContextProvider } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeOrganizationIdentity,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { getBackofficeRequestState } from "@/worker-runtime/request-state";
import type { BackofficeWorkerContextValue } from "@/worker-runtime/router-context";

import type { AutomationReplicaSource } from "./replica-source";

/** Describes the scope's Automations backend, which names its replica, with the scoped runtime authority. */
export async function loadAutomationReplicaSource<
  TOrganization extends BackofficeOrganizationIdentity,
>(
  request: Request,
  workerContext: BackofficeWorkerContextValue,
  resolvedScope: BackofficeResolvedScope<TOrganization>,
): Promise<AutomationReplicaSource<TOrganization>> {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const automations = workerContext.kernel.scoped(
    "AUTOMATIONS",
    runtimeScope,
    workerContext.runtime.objects.automations,
  );
  const description = await fetchFragnoInternalDescription({
    internalUrl: resolveFragnoInternalUrls(new URL("/api/automations", request.url)).internal,
    signal: request.signal,
    fetch: (input, init) => automations.http.fetch(new Request(input, init)),
  });

  return {
    resolvedScope,
    adapterIdentity: description.adapterIdentity,
  };
}

/** Returns the request-coalesced Automations replica source for a canonical scope. */
export function fetchAutomationReplicaSource<TOrganization extends BackofficeOrganizationIdentity>(
  _request: Request,
  context: Readonly<RouterContextProvider>,
  resolvedScope: BackofficeResolvedScope<TOrganization>,
): Promise<AutomationReplicaSource<TOrganization>> {
  return getBackofficeRequestState(context).getAutomationReplicaSource(resolvedScope);
}
