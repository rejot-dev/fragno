import type { RouterContextProvider } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromSinglePathSegment,
  backofficeContextScopeSinglePathSegment,
  BackofficeScopeCodecError,
} from "@/backoffice-runtime/scope-codec";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type ScopedPiRouteParams = {
  scopeSegment?: string;
  "*"?: string;
};

export async function forwardScopedPiRequest({
  request,
  context,
  params,
  mountRoute,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: ScopedPiRouteParams;
  mountRoute: "/api/pi" | "/api/pi-workflows";
}): Promise<Response> {
  if (!params.scopeSegment) {
    return new Response("Missing Pi scope", { status: 400 });
  }

  let scope;
  try {
    scope = backofficeContextScopeFromSinglePathSegment(params.scopeSegment);
  } catch (error) {
    if (error instanceof BackofficeScopeCodecError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
  await requireBackofficeContext(request, context, scope);

  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const piObject = kernel.scoped("PI", scope, runtime.objects.pi);
  const suffix = params["*"] ? `/${params["*"]}` : "";
  const url = new URL(request.url);
  url.pathname = `${mountRoute}${suffix}`;
  url.searchParams.set("scope", backofficeContextScopeSinglePathSegment(scope));

  return await piObject.fetch(new Request(url.toString(), request));
}
