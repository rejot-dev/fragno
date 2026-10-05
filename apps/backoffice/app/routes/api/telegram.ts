import { removeBackofficeInternalContextHeader } from "@/backoffice-runtime/internal-object-request";
import { backofficeContextScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { appendBackofficeScopeQuery } from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/telegram";

const TELEGRAM_MOUNT = "/api/telegram";

async function forwardToTelegram(
  request: Request,
  context: Route.LoaderArgs["context"],
  scopeSegment: string | undefined,
) {
  if (!scopeSegment) {
    return new Response("Missing scope", { status: 400 });
  }

  let scope;
  try {
    scope = backofficeContextScopeFromSinglePathSegment(scopeSegment);
  } catch {
    return new Response("Invalid scope", { status: 400 });
  }

  const url = new URL(request.url);
  const prefix = `${TELEGRAM_MOUNT}/`;
  if (!url.pathname.startsWith(prefix)) {
    return new Response("Not Found", { status: 404 });
  }
  const scopedPath = url.pathname.slice(prefix.length);
  const separator = scopedPath.indexOf("/");
  if (separator === -1) {
    return new Response("Not Found", { status: 404 });
  }
  try {
    if (decodeURIComponent(scopedPath.slice(0, separator)) !== scopeSegment) {
      return new Response("Not Found", { status: 404 });
    }
  } catch {
    return new Response("Invalid scope", { status: 400 });
  }
  const publicPathSuffix = scopedPath.slice(separator);
  url.pathname = `${TELEGRAM_MOUNT}${publicPathSuffix}`;
  appendBackofficeScopeQuery(url, scope);
  const outboundRequest = removeBackofficeInternalContextHeader(
    new Request(url.toString(), request),
  );
  const worker = context.get(BackofficeWorkerContext);

  if (request.method === "POST" && publicPathSuffix === "/telegram/webhook") {
    // Telegram proves webhook authority with its configured secret inside the fragment handler.
    return await worker.runtime.objects.telegram.for(scope).http.fetch(outboundRequest);
  }

  const auth = await authorizeBackofficeContext(request, context, scope);
  if (!auth.ok) {
    return auth.response;
  }
  const response = await worker.runtime.objects.telegram
    .for(scope)
    .http.fetchAuthorized(outboundRequest, { execution: auth.execution, propagationContext: null });
  if (auth.headers.length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of auth.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Forwards authenticated execution to Telegram's object-owned authorization middleware. */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return await forwardToTelegram(request, context, params.scopeSegment);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return await forwardToTelegram(request, context, params.scopeSegment);
}
