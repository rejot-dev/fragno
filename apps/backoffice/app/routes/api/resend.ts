import { backofficeContextScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
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

  const authorization = await authorizeBackofficeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }

  const resendDo = context.get(BackofficeWorkerContext).runtime.objects.resend.for(scope);
  const url = new URL(request.url);
  const prefix = `/api/resend/${scopeSegment}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/resend${suffix}`;
  }
  const proxyRequest = new Request(url.toString(), request);
  const response = await resendDo.http.fetch(proxyRequest);
  const headers = new Headers(response.headers);
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
