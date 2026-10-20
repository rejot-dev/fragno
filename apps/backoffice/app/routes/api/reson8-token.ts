import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { parseBackofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/reson8-token";

/**
 * Mints a short-lived Reson8 token under the platform key, so the browser streams dictation to
 * Reson8 directly. Realtime audio never passes through Backoffice, so it is not billed.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  let scope;
  try {
    scope = parseBackofficeScopePathSegment(params.scopeSegment);
  } catch {
    return new Response("Invalid Reson8 scope", { status: 404 });
  }
  const authorization = await authorizeBackofficeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const reson8 = runtime.reson8;
  if (!reson8) {
    return new Response("Reson8 is not configured.", { status: 404 });
  }

  let response: Response;
  try {
    response = await kernel.invoke({
      execution: authorization.execution,
      operation: BACKOFFICE_PERMISSION.reson8.transcribe,
      // In-process: the fragment would prefer the caller's Authorization header over the key.
      execute: () => reson8.callRouteRaw("POST", "/auth/token"),
    });
  } catch (error) {
    if (isBackofficeForbiddenError(error)) {
      return new Response(error.message, { status: 403, headers: authorization.headers });
    }
    throw error;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
