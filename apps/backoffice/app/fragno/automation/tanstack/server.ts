import type { RouterContextProvider } from "react-router";

import { fetchFragnoOutboxDescription } from "@fragno-dev/tanstack-db-adapter";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeOrganizationIdentity,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { getBackofficeRequestState } from "@/worker-runtime/request-state";
import type { BackofficeWorkerContextValue } from "@/worker-runtime/router-context";

import type { AutomationCollectionSource } from "./browser-database";

/** Loads one Automations adapter description from the scoped runtime authority. */
export async function loadAutomationCollectionSource<
  TOrganization extends BackofficeOrganizationIdentity,
>(
  request: Request,
  workerContext: BackofficeWorkerContextValue,
  resolvedScope: BackofficeResolvedScope<TOrganization>,
): Promise<AutomationCollectionSource<TOrganization>> {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const automations = workerContext.kernel.scoped(
    "AUTOMATIONS",
    runtimeScope,
    workerContext.runtime.objects.automations,
  );
  const description = await fetchFragnoOutboxDescription({
    baseUrl: new URL("/api/automations", request.url),
    signal: request.signal,
    fetch: (input, init) => automations.http.fetch(new Request(input, init)),
  });

  return {
    resolvedScope,
    adapterIdentity: description.adapterIdentity,
  };
}

/** Returns the request-coalesced Automations collection source for a canonical scope. */
export function fetchAutomationCollectionSource<
  TOrganization extends BackofficeOrganizationIdentity,
>(
  _request: Request,
  context: Readonly<RouterContextProvider>,
  resolvedScope: BackofficeResolvedScope<TOrganization>,
): Promise<AutomationCollectionSource<TOrganization>> {
  return getBackofficeRequestState(context).getAutomationCollectionSource(resolvedScope);
}
