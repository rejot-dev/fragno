import type { ApiObject } from "@/backoffice-runtime/object-registry";
import { backofficeScopeRouteId } from "@/backoffice-runtime/scope-codec";
import {
  forwardScopedPublicRequest,
  type ScopedPublicFragmentProxy,
} from "@/fragno/scoped-public-fragment-proxy";
import {
  API_INTERNAL_OAUTH_CALLBACK_PATH,
  API_INTERNAL_PREFIX,
  API_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/api";

const isPublicWebhookReceiveRequest = (request: Request, _scope: unknown, suffix: string) => {
  if (request.method !== "POST") {
    return false;
  }
  if (!suffix.startsWith("/webhooks/endpoints/")) {
    return false;
  }
  const [endpointId, tail, ...rest] = suffix.slice("/webhooks/endpoints/".length).split("/");
  return Boolean(endpointId) && tail === "events" && rest.length === 0;
};

const apiPublicProxy = {
  publicPrefix: API_PUBLIC_PREFIX,
  internalPrefix: API_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.api.for(scope),
  isAnonymousRequest: isPublicWebhookReceiveRequest,
  oauth: {
    internalCallbackPath: API_INTERNAL_OAUTH_CALLBACK_PATH,
    invalidResponse: (message) => new Response(message, { status: 502 }),
    redirect: ({ request, scope, status, code, message }) => {
      const redirectUrl = new URL(
        `/backoffice/automations/${scope.kind}/${encodeURIComponent(backofficeScopeRouteId(scope))}/api`,
        request.url,
      );
      redirectUrl.searchParams.set("tab", "connections");
      redirectUrl.searchParams.set("oauth", status);

      const connectionSlug = new URL(request.url).searchParams.get("state")?.split(":")[0]?.trim();
      if (connectionSlug) {
        redirectUrl.searchParams.set("connection", connectionSlug);
      }
      if (code) {
        redirectUrl.searchParams.set("code", code);
      }
      if (message) {
        redirectUrl.searchParams.set("message", message);
      }

      return Response.redirect(redirectUrl, 302);
    },
  },
} satisfies ScopedPublicFragmentProxy<ApiObject>;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardScopedPublicRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    proxy: apiPublicProxy,
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardScopedPublicRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    proxy: apiPublicProxy,
  });
}
