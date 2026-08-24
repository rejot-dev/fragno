import type { RouterContextProvider } from "react-router";

import { fetchFragnoOutboxDescription } from "@fragno-dev/tanstack-db-adapter";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeOrganizationIdentity,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { AutomationCollectionSource } from "./browser-database";

export async function fetchAutomationCollectionSource<
  TOrganization extends BackofficeOrganizationIdentity,
>(
  request: Request,
  context: Readonly<RouterContextProvider>,
  resolvedScope: BackofficeResolvedScope<TOrganization>,
): Promise<AutomationCollectionSource<TOrganization>> {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const automations = kernel.scoped("AUTOMATIONS", runtimeScope, runtime.objects.automations);
  const description = await fetchFragnoOutboxDescription({
    baseUrl: new URL("/api/automations", request.url),
    signal: request.signal,
    fetch: (input, init) => automations.fetch(new Request(input, init)),
  });

  return {
    resolvedScope,
    adapterIdentity: description.adapterIdentity,
  };
}
