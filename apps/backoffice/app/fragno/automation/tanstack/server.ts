import type { RouterContextProvider } from "react-router";

import { fetchFragnoOutboxDescription } from "@fragno-dev/tanstack-db-adapter";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { AutomationCollectionSource } from "./browser-database";

export async function fetchAutomationCollectionSource(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<AutomationCollectionSource> {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const automations = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
  const description = await fetchFragnoOutboxDescription({
    baseUrl: new URL("/api/automations", request.url),
    signal: request.signal,
    fetch: (input, init) => automations.fetch(new Request(input, init)),
  });

  return {
    scope,
    adapterIdentity: description.adapterIdentity,
  };
}
