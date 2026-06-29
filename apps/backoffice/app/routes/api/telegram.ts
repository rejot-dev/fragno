import {
  backofficeContextScopeFromSinglePathSegment,
  backofficeContextScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/telegram";

const TELEGRAM_MOUNT = "/api/telegram";

const forwardToTelegram = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  scopeSegment: string | undefined,
) => {
  if (!scopeSegment) {
    return new Response("Missing scope", { status: 400 });
  }

  let scope;
  try {
    scope = backofficeContextScopeFromSinglePathSegment(scopeSegment);
  } catch {
    return new Response("Invalid scope", { status: 400 });
  }

  const telegramDo = context.get(BackofficeWorkerContext).runtime.objects.telegram.for(scope);
  const url = new URL(request.url);
  const encodedScopeSegment = backofficeContextScopeSinglePathSegment(scope);
  const prefix = `${TELEGRAM_MOUNT}/${encodedScopeSegment}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `${TELEGRAM_MOUNT}${suffix}`;
  }

  return telegramDo.fetch(new Request(url.toString(), request));
};

/**
 * Catch-all route that forwards all /api/telegram/:scopeSegment/* requests to the Telegram Durable Object.
 * The scope-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToTelegram(request, context, params.scopeSegment);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToTelegram(request, context, params.scopeSegment);
}
