import { createFetchFragnoOutboxTransport } from "@fragno-dev/tanstack-db-adapter/transport";
import type { RouterContextProvider } from "react-router";

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
  const internalUrl = new URL("/api/automations/_internal", request.url);
  const transport = createFetchFragnoOutboxTransport({
    internalUrl,
    fetch: (input, init) => automations.fetch(new Request(input, init)),
  });

  return {
    scope,
    adapterIdentity: await transport.getAdapterIdentity({ signal: request.signal }),
  };
}
