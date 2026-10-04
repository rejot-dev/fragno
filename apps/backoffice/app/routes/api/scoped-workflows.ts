import type { RouterContextProvider } from "react-router";

import {
  backofficeContextScopeFromSinglePathSegment,
  backofficeContextScopeSinglePathSegment,
  isBackofficeScopeCodecError,
} from "@/backoffice-runtime/scope-codec";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type ScopedWorkflowsRouteParams = {
  scopeSegment?: string;
  "*"?: string;
};

export async function forwardScopedWorkflowsRequest({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: ScopedWorkflowsRouteParams;
}): Promise<Response> {
  if (!params.scopeSegment) {
    return new Response("Missing Workflows scope", { status: 400 });
  }

  let scope;
  try {
    scope = backofficeContextScopeFromSinglePathSegment(params.scopeSegment);
  } catch (error) {
    if (isBackofficeScopeCodecError(error)) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
  const execution = await requireBackofficeContext(request, context, scope);

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const automationsObject = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
  const suffix = params["*"] ? `/${params["*"]}` : "";
  const url = new URL(request.url);
  url.pathname = `/api/workflows${suffix}`;
  url.searchParams.set("scope", backofficeContextScopeSinglePathSegment(scope));

  return await automationsObject.http.fetchAuthorized(new Request(url.toString(), request), {
    execution,
    propagationContext: null,
  });
}
