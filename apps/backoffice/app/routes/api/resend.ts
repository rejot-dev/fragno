import { backofficeContextScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/resend";

const forwardToResend = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  scopeSegment: string | undefined,
) => {
  if (!scopeSegment) {
    return new Response("Missing Resend scope", { status: 400 });
  }

  let scope;
  try {
    scope = backofficeContextScopeFromSinglePathSegment(scopeSegment);
  } catch {
    return new Response("Invalid Resend scope", { status: 404 });
  }

  const resendDo = context.get(BackofficeWorkerContext).runtime.objects.resend.for(scope);
  const url = new URL(request.url);
  const prefix = `/api/resend/${scopeSegment}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/resend${suffix}`;
  }
  const proxyRequest = new Request(url.toString(), request);
  return resendDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/resend/:scopeSegment/* requests to the Resend Durable Object.
 * The scope-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToResend(request, context, params.scopeSegment);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToResend(request, context, params.scopeSegment);
}
