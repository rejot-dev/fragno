import { parseBackofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { scopedPublicFragmentPathSuffix } from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/resend";

async function forwardToResend(
  request: Request,
  context: Route.LoaderArgs["context"],
  scopeSegment: string | undefined,
) {
  if (!scopeSegment) {
    return new Response("Missing Resend scope", { status: 400 });
  }

  let scope;
  try {
    scope = parseBackofficeScopePathSegment(scopeSegment);
  } catch {
    return new Response("Invalid Resend scope", { status: 404 });
  }

  const url = new URL(request.url);
  const publicPathSuffix = scopedPublicFragmentPathSuffix({
    pathname: url.pathname,
    publicPrefix: "/api/resend",
    scopePathSegment: scopeSegment,
  });
  if (publicPathSuffix === null) {
    return new Response("Not Found", { status: 404 });
  }
  const isPublicWebhook = request.method === "POST" && publicPathSuffix === "/webhook";
  // Provider deliveries have no Backoffice session; the fragment verifies their signatures.
  const authorization = isPublicWebhook
    ? { ok: true as const, execution: null, headers: [] }
    : await authorizeBackofficeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }

  const resendDo = context.get(BackofficeWorkerContext).runtime.objects.resend.for(scope);
  url.pathname = `/api/resend${publicPathSuffix}`;
  const proxyRequest = new Request(url.toString(), request);
  const response = authorization.execution
    ? await resendDo.http.fetchAuthorized(proxyRequest, {
        execution: authorization.execution,
      })
    : await resendDo.http.fetch(proxyRequest);
  const headers = new Headers(response.headers);
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
