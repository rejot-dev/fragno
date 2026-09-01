import { RouterContextProvider } from "react-router";

import { verifyBackofficeJwt } from "@/fragno/auth/token-lifecycle";
import { loadAutomationCollectionSource } from "@/fragno/automation/tanstack/server";

import { BackofficeRequestStateContext } from "./request-state";
import { createBackofficeRequestState } from "./request-state.server";
import { BackofficeWorkerContext, type BackofficeWorkerContextValue } from "./router-context";

/** Creates the canonical React Router context boundary for one Backoffice HTTP request. */
export function createBackofficeRouterContextProvider(
  request: Request,
  workerContext: BackofficeWorkerContextValue,
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, workerContext);
  context.set(
    BackofficeRequestStateContext,
    createBackofficeRequestState(request, {
      getAuthObject: () => workerContext.runtime.objects.auth.singleton(),
      verifyJwt: verifyBackofficeJwt,
      loadAutomationCollectionSource: (resolvedScope) =>
        loadAutomationCollectionSource(request, workerContext, resolvedScope),
    }),
  );
  return context;
}
